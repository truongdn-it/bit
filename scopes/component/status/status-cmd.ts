import chalk from 'chalk';
import R from 'ramda';
import { Command, CommandOptions } from '@teambit/cli';
import { ComponentID } from '@teambit/component-id';
import { SnapsDistance } from '@teambit/legacy/dist/scope/component-ops/snaps-distance';
import { IssuesList } from '@teambit/component-issues';
import { formatBitString } from '@teambit/legacy/dist/cli/chalk-box';
import { getInvalidComponentLabel } from '@teambit/legacy/dist/cli/templates/component-issues-template';
import {
  IMPORT_PENDING_MSG,
  statusFailureMsg,
  statusInvalidComponentsMsg,
  statusWorkspaceIsCleanMsg,
  BASE_DOCS_DOMAIN,
} from '@teambit/legacy/dist/constants';
import { compact, partition } from 'lodash';
import { isHash } from '@teambit/component-version';
import { StatusMain, StatusResult } from './status.main.runtime';

const TROUBLESHOOTING_MESSAGE = `${chalk.yellow(
  `learn more at about Bit component: ${BASE_DOCS_DOMAIN}reference/components/component-anatomy/`
)}`;

type StatusFlags = { strict?: boolean; verbose?: boolean; lanes?: boolean; ignoreCircularDependencies?: boolean };

type StatusJsonResults = {
  newComponents: string[];
  modifiedComponents: string[];
  stagedComponents: Array<{ id: string; versions: string[] }>;
  unavailableOnMain: string[];
  componentsWithIssues: Array<{
    id: string;
    issues: Array<{
      type: string;
      description: string;
      data: any;
    }>;
  }>;
  importPendingComponents: string[];
  autoTagPendingComponents: string[];
  invalidComponents: Array<{ id: string; error: Error }>;
  locallySoftRemoved: string[];
  remotelySoftRemoved: string[];
  outdatedComponents: Array<{ id: string; headVersion: string; latestVersion?: string }>;
  mergePendingComponents: string[];
  componentsDuringMergeState: string[];
  softTaggedComponents: string[];
  snappedComponents: string[];
  pendingUpdatesFromMain: Array<{
    id: string;
    divergeData: any;
  }>;
  updatesFromForked: Array<{
    id: string;
    divergeData: any;
  }>;
  currentLaneId: string;
  forkedLaneId: string | undefined;
  workspaceIssues: string[];
};

export class StatusCmd implements Command {
  name = 'status';
  description = 'present the current status of components in the workspace, including indication of detected issues';
  group = 'development';
  extendedDescription: string;
  alias = 's';
  options = [
    ['j', 'json', 'return a json version of the component'],
    ['', 'verbose', 'show extra data: full snap hashes for staged components, and divergence point for lanes'],
    ['l', 'lanes', 'when on a lane, show updates from main and updates from forked lanes'],
    ['', 'strict', 'in case issues found, exit with code 1'],
    ['c', 'ignore-circular-dependencies', 'do not check for circular dependencies to get the results quicker'],
  ] as CommandOptions;
  loader = true;
  migration = true;

  constructor(private status: StatusMain) {}

  async json(_args, { lanes, ignoreCircularDependencies }: StatusFlags): Promise<StatusJsonResults> {
    const {
      newComponents,
      modifiedComponents,
      stagedComponents,
      componentsWithIssues,
      importPendingComponents,
      autoTagPendingComponents,
      invalidComponents,
      locallySoftRemoved,
      remotelySoftRemoved,
      outdatedComponents,
      mergePendingComponents,
      componentsDuringMergeState,
      softTaggedComponents,
      snappedComponents,
      unavailableOnMain,
      pendingUpdatesFromMain,
      updatesFromForked,
      currentLaneId,
      forkedLaneId,
      workspaceIssues,
    }: StatusResult = await this.status.status({ lanes, ignoreCircularDependencies });
    return {
      newComponents: newComponents.map((c) => c.toStringWithoutVersion()),
      modifiedComponents: modifiedComponents.map((c) => c.toStringWithoutVersion()),
      stagedComponents: stagedComponents.map((c) => ({ id: c.id.toStringWithoutVersion(), versions: c.versions })),
      unavailableOnMain: unavailableOnMain.map((c) => c.toStringWithoutVersion()),
      componentsWithIssues: componentsWithIssues.map((c) => ({
        id: c.id.toStringWithoutVersion(),
        issues: c.issues?.toObjectIncludeDataAsString(),
      })),
      importPendingComponents: importPendingComponents.map((id) => id.toStringWithoutVersion()),
      autoTagPendingComponents: autoTagPendingComponents.map((s) => s.toStringWithoutVersion()),
      invalidComponents: invalidComponents.map(({ id, error }) => ({ id: id.toStringWithoutVersion(), error })),
      locallySoftRemoved: locallySoftRemoved.map((id) => id.toStringWithoutVersion()),
      remotelySoftRemoved: remotelySoftRemoved.map((id) => id.toStringWithoutVersion()),
      outdatedComponents: outdatedComponents.map((c) => ({ ...c, id: c.id.toStringWithoutVersion() })),
      mergePendingComponents: mergePendingComponents.map((c) => c.id.toStringWithoutVersion()),
      componentsDuringMergeState: componentsDuringMergeState.map((id) => id.toStringWithoutVersion()),
      softTaggedComponents: softTaggedComponents.map((s) => s.toStringWithoutVersion()),
      snappedComponents: snappedComponents.map((s) => s.toStringWithoutVersion()),
      pendingUpdatesFromMain: pendingUpdatesFromMain.map((p) => ({
        id: p.id.toStringWithoutVersion(),
        divergeData: p.divergeData,
      })),
      updatesFromForked: updatesFromForked.map((p) => ({
        id: p.id.toStringWithoutVersion(),
        divergeData: p.divergeData,
      })),
      currentLaneId: currentLaneId.toString(),
      forkedLaneId: forkedLaneId?.toString(),
      workspaceIssues,
    };
  }

  // eslint-disable-next-line complexity
  async report(_args, { strict, verbose, lanes, ignoreCircularDependencies }: StatusFlags) {
    const {
      newComponents,
      modifiedComponents,
      stagedComponents,
      componentsWithIssues,
      importPendingComponents,
      autoTagPendingComponents,
      invalidComponents,
      locallySoftRemoved,
      remotelySoftRemoved,
      outdatedComponents,
      mergePendingComponents,
      componentsDuringMergeState,
      softTaggedComponents,
      snappedComponents,
      pendingUpdatesFromMain,
      updatesFromForked,
      unavailableOnMain,
      currentLaneId,
      forkedLaneId,
      workspaceIssues,
    }: StatusResult = await this.status.status({ lanes, ignoreCircularDependencies });
    // If there is problem with at least one component we want to show a link to the
    // troubleshooting doc
    let showTroubleshootingLink = false;

    function format(id: ComponentID, showIssues = false, message?: string, localVersions?: string[]): string {
      const idWithIssues = componentsWithIssues.find((c) => c.id.isEqual(id));
      const softTagged = softTaggedComponents.find((softTaggedId) => softTaggedId.isEqual(id));

      const messageStatusText = message || 'ok';
      const messageStatusTextWithSoftTag = softTagged ? `${messageStatusText} (soft-tagged)` : messageStatusText;
      const color = message ? 'yellow' : 'green';
      const messageStatus = chalk[color](messageStatusTextWithSoftTag);

      if (!showIssues && !localVersions) {
        return `${formatBitString(id.toStringWithoutVersion())} ... ${messageStatus}`;
      }
      let bitFormatted = `${formatBitString(id.toStringWithoutVersion())}`;
      if (localVersions) {
        if (verbose) {
          bitFormatted += `. versions: ${localVersions.join(', ')}`;
        } else {
          const [snaps, tags] = partition(localVersions, (version) => isHash(version));
          const tagsStr = tags.length ? `versions: ${tags.join(', ')}` : '';
          const snapsStr = snaps.length ? `${snaps.length} snap(s)` : '';
          bitFormatted += `. `;
          bitFormatted += tagsStr && snapsStr ? `${tagsStr}. and ${snapsStr}` : tagsStr || snapsStr;
        }
      }
      bitFormatted += ' ... ';
      if (showIssues && idWithIssues) {
        showTroubleshootingLink = true;
        return `${bitFormatted} ${chalk.red(statusFailureMsg)}${formatIssues(idWithIssues.issues)}`;
      }
      return `${bitFormatted}${messageStatus}`;
    }

    function formatCategory(title: string, description: string, compsOutput: string[]) {
      if (!compsOutput.length) return '';
      const titleOutput = chalk.underline.white(`${title} (${compsOutput.length})`);
      const descOutput = description ? `${description}\n` : '';
      return [titleOutput, descOutput, ...compsOutput].join('\n');
    }

    const importPendingWarning = importPendingComponents.length ? chalk.yellow(`${IMPORT_PENDING_MSG}.\n`) : '';

    const splitByMissing = R.groupBy((component) => {
      return component.includes(statusFailureMsg) ? 'missing' : 'nonMissing';
    });
    const { missing, nonMissing } = splitByMissing(newComponents.map((c) => format(c)));

    const outdatedTitle = 'pending updates';
    const outdatedDesc =
      '(use "bit checkout head" to merge changes)\n(use "bit diff [component_id] [new_version]" to compare changes)\n(use "bit log [component_id]" to list all available versions)';
    const outdatedComps = outdatedComponents.map((component) => {
      const latest =
        component.latestVersion && component.latestVersion !== component.headVersion
          ? ` latest: ${component.latestVersion}`
          : '';
      return `    > ${chalk.cyan(component.id.toStringWithoutVersion())} current: ${component.id.version} head: ${
        component.headVersion
      }${latest}`;
    });
    const outdatedStr = formatCategory(outdatedTitle, outdatedDesc, outdatedComps);

    const pendingMergeTitle = 'pending merge';
    const pendingMergeDesc = `(use "bit reset" to discard local tags/snaps, and bit checkout head to re-merge with the remote.
alternatively, to keep local tags/snaps history, use "bit merge [component-id]")`;
    const pendingMergeComps = mergePendingComponents.map((component) => {
      return `    > ${chalk.cyan(component.id.toString())} local and remote have diverged and have ${
        component.divergeData.snapsOnSourceOnly.length
      } (source) and ${component.divergeData.snapsOnTargetOnly.length} (target) uncommon snaps respectively`;
    });

    const pendingMergeStr = formatCategory(pendingMergeTitle, pendingMergeDesc, pendingMergeComps);

    const compDuringMergeTitle = 'components in merge state';
    const compDuringMergeDesc = `(use "bit snap/tag [--unmerged]" to complete the merge process.
to cancel the merge operation, use either "bit lane merge-abort" (for prior "bit lane merge" command)
or use "bit merge [component-id] --abort" (for prior "bit merge" command)`;
    const compDuringMergeComps = componentsDuringMergeState.map((c) => format(c));

    const compDuringMergeStr = formatCategory(compDuringMergeTitle, compDuringMergeDesc, compDuringMergeComps);

    const newComponentDescription = '\n(use "bit snap/tag" to lock a version with all your changes)\n';
    const newComponentsTitle = newComponents.length
      ? chalk.underline.white('new components') + newComponentDescription
      : '';

    const newComponentsOutput = [newComponentsTitle, ...(nonMissing || []), ...(missing || [])].join('\n');

    const modifiedDesc = '(use "bit diff" to compare changes)';
    const modifiedComponentOutput = formatCategory(
      'modified components',
      modifiedDesc,
      modifiedComponents.map((c) => format(c))
    );

    const autoTagPendingTitle = 'components pending auto-tag (when their modified dependencies are tagged)';
    const autoTagPendingOutput = formatCategory(
      autoTagPendingTitle,
      '',
      autoTagPendingComponents.map((c) => format(c))
    );

    const compWithIssuesDesc = '(fix the issues according to the suggested solution)';
    const compWithIssuesOutput = formatCategory(
      'components with issues',
      compWithIssuesDesc,
      componentsWithIssues.map((c) => format(c.id, true)).sort()
    );

    const invalidDesc = 'these components failed to load';
    const invalidComps = invalidComponents.map((c) => format(c.id, false, getInvalidComponentLabel(c.error))).sort();
    const invalidComponentOutput = formatCategory(statusInvalidComponentsMsg, invalidDesc, invalidComps);

    const locallySoftRemovedDesc =
      '(tag/snap and export the components to update the deletion to the remote. to undo deletion, run "bit recover")';
    const locallySoftRemovedOutput = formatCategory(
      'soft-removed components locally',
      locallySoftRemovedDesc,
      locallySoftRemoved.map((c) => format(c)).sort()
    );

    const remotelySoftRemovedDesc =
      '(use "bit remove" to remove them from the workspace. use "bit recover" to undo the soft-remove)';
    const remotelySoftRemovedOutput = formatCategory(
      'components deleted on the remote',
      remotelySoftRemovedDesc,
      remotelySoftRemoved.map((c) => format(c)).sort()
    );

    const stagedDesc = '(use "bit export" to push these component versions to the remote scope)';
    const stagedComps = stagedComponents.map((c) => format(c.id, false, undefined, c.versions));
    const stagedComponentsOutput = formatCategory('staged components', stagedDesc, stagedComps);

    const snappedDesc = '(use "bit tag" or "bit tag --snapped" to lock a semver version)';
    const snappedComponentsOutput = formatCategory(
      'snapped components (tag pending)',
      snappedDesc,
      snappedComponents.map((c) => format(c))
    );

    const unavailableOnMainDesc = '(use "bit checkout head" to make them available)';
    const unavailableOnMainOutput = formatCategory(
      'components unavailable on main',
      unavailableOnMainDesc,
      unavailableOnMain.map((c) => format(c))
    );

    const getUpdateFromMsg = (divergeData: SnapsDistance, from = 'main'): string => {
      if (divergeData.err) return divergeData.err.message;
      let msg = `${from} is ahead by ${divergeData.snapsOnTargetOnly.length || 0} snaps`;
      if (divergeData.snapsOnSourceOnly && verbose) {
        msg += ` (diverged since ${divergeData.commonSnapBeforeDiverge?.toShortString()})`;
      }
      return msg;
    };

    const updatesFromMainDesc = '(use "bit lane merge main" to merge the changes)';
    const pendingUpdatesFromMainIds = pendingUpdatesFromMain.map((c) =>
      format(c.id, false, getUpdateFromMsg(c.divergeData))
    );
    const updatesFromMainOutput = formatCategory(
      'pending updates from main',
      updatesFromMainDesc,
      pendingUpdatesFromMainIds
    );

    let updatesFromForkedOutput = '';
    if (forkedLaneId) {
      const updatesFromForkedDesc = `(use "bit lane merge ${forkedLaneId.toString()}" to merge the changes
use "bit fetch ${forkedLaneId.toString()} --lanes" to update ${forkedLaneId.name} locally)`;
      const pendingUpdatesFromForkedIds = updatesFromForked.map((c) =>
        format(c.id, false, getUpdateFromMsg(c.divergeData, forkedLaneId.name))
      );
      updatesFromForkedOutput = formatCategory(
        `updates from ${forkedLaneId.name}`,
        updatesFromForkedDesc,
        pendingUpdatesFromForkedIds
      );
    }

    const getLaneStr = () => {
      if (currentLaneId.isDefault()) return '';
      const prefix = `\n\ncurrent lane ${chalk.bold(currentLaneId.toString())}`;
      if (lanes) return prefix;
      return `${prefix}\nconsider adding "--lanes" flag to see updates from main/forked`;
    };

    const getWorkspaceIssuesOutput = () => {
      if (!workspaceIssues.length) return '';
      const title = chalk.underline.white('workspace issues');
      const issues = workspaceIssues.join('\n');
      return `\n\n${title}\n${issues}`;
    };

    const troubleshootingStr = showTroubleshootingLink ? `\n${TROUBLESHOOTING_MESSAGE}` : '';

    const statusMsg =
      importPendingWarning +
      compact([
        outdatedStr,
        pendingMergeStr,
        updatesFromMainOutput,
        updatesFromForkedOutput,
        compDuringMergeStr,
        newComponentsOutput,
        modifiedComponentOutput,
        snappedComponentsOutput,
        stagedComponentsOutput,
        unavailableOnMainOutput,
        autoTagPendingOutput,
        compWithIssuesOutput,
        invalidComponentOutput,
        locallySoftRemovedOutput,
        remotelySoftRemovedOutput,
      ]).join(chalk.underline('\n                         \n') + chalk.white('\n')) +
      troubleshootingStr;

    const results = (statusMsg || chalk.yellow(statusWorkspaceIsCleanMsg)) + getWorkspaceIssuesOutput() + getLaneStr();

    const exitCode = componentsWithIssues.length && strict ? 1 : 0;

    return {
      data: results,
      code: exitCode,
    };
  }
}

export function formatIssues(issues: IssuesList) {
  return `       ${issues?.outputForCLI()}\n`;
}

import chalk from 'chalk';
import { IssuesClasses } from '@teambit/component-issues';
import { Command, CommandOptions } from '@teambit/cli';
import { BitError } from '@teambit/bit-error';
import { Logger } from '@teambit/logger';
import { SnappingMain } from './snapping.main.runtime';
import { BasicTagSnapParams } from './tag-model-component';

export type FileData = { path: string; content: string; delete?: boolean };

export type SnapDataPerCompRaw = {
  componentId: string;
  dependencies?: string[];
  aspects?: Record<string, any>;
  message?: string;
  files?: FileData[];
  isNew?: boolean;
  mainFile?: string; // relevant when isNew is true. default to "index.ts".
  newDependencies?: Array<{
    id: string; // component-id or package-name. e.g. "teambit.react/react" or "lodash".
    version?: string; // version of the package. e.g. "2.0.3". for packages, it is mandatory.
    isComponent?: boolean; // default true. if false, it's a package dependency
    type?: 'runtime' | 'dev' | 'peer'; // default "runtime".
  }>;
};

type SnapFromScopeOptions = {
  push?: boolean;
  lane?: string;
  ignoreIssues?: string;
  disableSnapPipeline?: boolean;
  forceDeploy?: boolean;
} & BasicTagSnapParams;

export class SnapFromScopeCmd implements Command {
  name = '_snap <data>';
  description = 'snap components from a bare-scope';
  extendedDescription = `this command should be running from a new bare scope, it first imports the components it needs and then processes the snap.
the input data is a stringified JSON of an array of the following object.
{
  componentId: string;     // ids always have scope, so it's safe to parse them from string
  dependencies?: string[]; // dependencies to update their versions, e.g. [teambit/compiler@1.0.0, teambit/tester@1.0.0]
  aspects?: Record<string,any> // e.g. { "teambit.react/react": {}, "teambit.envs/envs": { "env": "teambit.react/react" } }
  message?: string;       // tag-message.
  files?: Array<{path: string, content: string}>; // replace content of specified source-files. the content is base64 encoded.
  isNew?: boolean;        // if it's new, it'll be generated from the given files. otherwise, it'll be fetched from the scope and updated.
  mainFile?: string;      // relevant when isNew is true. default to "index.ts".
  newDependencies?: Array<{  // new dependencies (components and packages) to add.
    id: string;              // component-id or package-name. e.g. "teambit.react/react" or "lodash".
    version?: string;        // version of the package. e.g. "2.0.3". for packages, it is mandatory.
    isComponent?: boolean;   // default true. if false, it's a package dependency
    type?: 'runtime' | 'dev' | 'peer'; // default "runtime".
  }>;
}
an example of the final data: '[{"componentId":"ci.remote2/comp-b","message": "first snap"}]'
`;
  alias = '';
  options = [
    ['', 'push', 'export the updated objects to the original scopes once done'],
    ['m', 'message <message>', 'log message describing the latest changes'],
    ['', 'lane <lane-id>', 'fetch the components from the given lane'],
    ['', 'build', 'run the build pipeline'],
    ['', 'skip-tests', 'skip running component tests during snap process'],
    ['', 'disable-snap-pipeline', 'skip the snap pipeline'],
    ['', 'force-deploy', 'DEPRECATED. use --ignore-build-error instead'],
    ['', 'ignore-build-errors', 'run the snap pipeline although the build pipeline failed'],
    ['', 'rebuild-deps-graph', 'do not reuse the saved dependencies graph, instead build it from scratch'],
    [
      'i',
      'ignore-issues [issues]',
      `ignore component issues (shown in "bit status" as "issues found"), issues to ignore:
[${Object.keys(IssuesClasses).join(', ')}]
to ignore multiple issues, separate them by a comma and wrap with quotes. to ignore all issues, specify "*".`,
    ],
    ['j', 'json', 'output as json format'],
  ] as CommandOptions;
  loader = true;
  private = true;
  migration = true;

  constructor(private snapping: SnappingMain, private logger: Logger) {}

  async report([data]: [string], options: SnapFromScopeOptions) {
    const results = await this.json([data], options);

    const { snappedIds, exportedIds } = results;

    const snappedOutput = `${chalk.bold('snapped components')}\n${snappedIds.join('\n')}`;
    const exportedOutput =
      exportedIds && exportedIds.length ? `\n\n${chalk.bold('exported components')}\n${exportedIds.join('\n')}` : '';

    return `${snappedOutput}${exportedOutput}`;
  }
  async json(
    [data]: [string],
    {
      push = false,
      message = '',
      lane,
      ignoreIssues,
      build = false,
      skipTests = false,
      disableSnapPipeline = false,
      ignoreBuildErrors = false,
      rebuildDepsGraph,
      forceDeploy = false,
    }: SnapFromScopeOptions
  ) {
    const disableTagAndSnapPipelines = disableSnapPipeline;
    if (forceDeploy) {
      ignoreBuildErrors = true;
    }
    if (disableTagAndSnapPipelines && ignoreBuildErrors) {
      throw new BitError('you can use either ignore-build-errors or disable-snap-pipeline, but not both');
    }

    const snapDataPerCompRaw = this.parseData(data);

    const results = await this.snapping.snapFromScope(snapDataPerCompRaw, {
      push,
      message,
      lane,
      ignoreIssues,
      build,
      skipTests,
      disableTagAndSnapPipelines,
      ignoreBuildErrors,
      rebuildDepsGraph,
    });

    return results;
  }
  private parseData(data: string): SnapDataPerCompRaw[] {
    let dataParsed: unknown;
    try {
      dataParsed = JSON.parse(data);
    } catch (err: any) {
      throw new Error(`failed parsing the data entered as JSON. err ${err.message}`);
    }
    if (!Array.isArray(dataParsed)) {
      throw new Error('expect data to be an array');
    }
    dataParsed.forEach((dataItem) => {
      if (!dataItem.componentId) throw new Error('expect data item to have "componentId" prop');
      dataItem.files?.forEach((file) => {
        if (!file.path) throw new Error('expect file to have "path" prop');
        if (file.content) {
          file.content = Buffer.from(file.content, 'base64').toString();
        }
      });
    });

    return dataParsed;
  }
}

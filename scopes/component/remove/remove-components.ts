import groupArray from 'group-array';
import partition from 'lodash.partition';
import R from 'ramda';
import { Consumer } from '@teambit/legacy/dist/consumer';
import { ComponentIdList } from '@teambit/component-id';
import { CENTRAL_BIT_HUB_NAME, CENTRAL_BIT_HUB_URL, LATEST_BIT_VERSION } from '@teambit/legacy/dist/constants';
import GeneralError from '@teambit/legacy/dist/error/general-error';
import enrichContextFromGlobal from '@teambit/legacy/dist/hooks/utils/enrich-context-from-global';
import logger from '@teambit/legacy/dist/logger/logger';
import { Http } from '@teambit/legacy/dist/scope/network/http';
import { Remotes } from '@teambit/legacy/dist/remotes';
import { getScopeRemotes } from '@teambit/legacy/dist/scope/scope-remotes';
import deleteComponentsFiles from '@teambit/legacy/dist/consumer/component-ops/delete-component-files';
import ComponentsList from '@teambit/legacy/dist/consumer/component/components-list';
import Component from '@teambit/legacy/dist/consumer/component/consumer-component';
import RemovedObjects from '@teambit/legacy/dist/scope/removed-components';
import * as packageJsonUtils from '@teambit/legacy/dist/consumer/component/package-json-utils';
import pMapSeries from 'p-map-series';
import { RemovedLocalObjects } from './removed-local-objects';

export type RemoveComponentsResult = { localResult: RemovedLocalObjects; remoteResult: RemovedObjects[] };

/**
 * Remove components local and remote
 * splits array of ids into local and remote and removes according to flags
 * @param {string[]} ids - list of remote component ids to delete
 * @param {boolean} force - delete component that are used by other components.
 * @param {boolean} remote - delete component from a remote scope
 * @param {boolean} track - keep tracking local staged components in bitmap.
 * @param {boolean} deleteFiles - delete local added files from fs.
 */
export async function removeComponents({
  consumer,
  ids,
  force,
  remote,
  track,
  deleteFiles,
}: {
  consumer: Consumer | null | undefined; // when remote is false, it's always set
  ids: ComponentIdList;
  force: boolean;
  remote: boolean;
  track: boolean;
  deleteFiles: boolean;
}): Promise<RemoveComponentsResult> {
  logger.debugAndAddBreadCrumb('removeComponents', `{ids}. force: ${force.toString()}`, { ids: ids.toString() });
  // added this to remove support for remove only one version from a component
  const bitIdsLatest = ComponentIdList.fromArray(
    ids.map((id) => {
      return id.changeVersion(LATEST_BIT_VERSION);
    })
  );
  const [localIds, remoteIds] = partition(bitIdsLatest, (id) => id.isLocal());
  if (remote && localIds.length) {
    throw new GeneralError(
      `unable to remove the remote components: ${localIds.join(',')} as they don't contain a scope-name`
    );
  }
  const remoteResult = remote && !R.isEmpty(remoteIds) ? await removeRemote(consumer, remoteIds, force) : [];
  const localResult = !remote
    ? await removeLocal(consumer as Consumer, bitIdsLatest, force, track, deleteFiles)
    : new RemovedLocalObjects();

  return { localResult, remoteResult };
}

/**
 * Remove remote component from ssh server
 * this method groups remote components by remote name and deletes remote components together
 * @param {ComponentIdList} bitIds - list of remote component ids to delete
 * @param {boolean} force - delete component that are used by other components.
 */
async function removeRemote(
  consumer: Consumer | null | undefined,
  bitIds: ComponentIdList,
  force: boolean
): Promise<RemovedObjects[]> {
  const groupedBitsByScope = groupArray(bitIds, 'scope');
  const remotes = consumer ? await getScopeRemotes(consumer.scope) : await Remotes.getGlobalRemotes();
  const shouldGoToCentralHub = remotes.shouldGoToCentralHub(Object.keys(groupedBitsByScope));
  if (shouldGoToCentralHub) {
    const http = await Http.connect(CENTRAL_BIT_HUB_URL, CENTRAL_BIT_HUB_NAME);
    return http.deleteViaCentralHub(
      bitIds.map((id) => id.toString()),
      { force, idsAreLanes: false }
    );
  }
  const context = {};
  enrichContextFromGlobal(context);
  const removeP = Object.keys(groupedBitsByScope).map(async (key) => {
    const resolvedRemote = await remotes.resolve(key, consumer?.scope);
    const idsStr = groupedBitsByScope[key].map((id) => id.toStringWithoutVersion());
    return resolvedRemote.deleteMany(idsStr, force, context);
  });

  return Promise.all(removeP);
}

/**
 * removeLocal - remove local (imported, new staged components) from modules and bitmap according to flags
 * @param {ComponentIdList} bitIds - list of component ids to delete
 * @param {boolean} force - delete component that are used by other components.
 * @param {boolean} deleteFiles - delete component that are used by other components.
 */
async function removeLocal(
  consumer: Consumer,
  bitIds: ComponentIdList,
  force: boolean,
  track: boolean,
  deleteFiles: boolean
): Promise<RemovedLocalObjects> {
  // local remove in case user wants to delete tagged components
  const modifiedComponents = new ComponentIdList();
  const nonModifiedComponents = new ComponentIdList();
  // @ts-ignore AUTO-ADDED-AFTER-MIGRATION-PLEASE-FIX!
  if (R.isEmpty(bitIds)) return new RemovedLocalObjects();
  if (!force) {
    await pMapSeries(bitIds, async (id) => {
      try {
        const componentStatus = await consumer.getComponentStatusById(id);
        if (componentStatus.modified) modifiedComponents.push(id);
        else nonModifiedComponents.push(id);
      } catch (err: any) {
        // if a component has an error, such as, missing main file, we do want to allow removing that component
        if (Component.isComponentInvalidByErrorType(err)) {
          nonModifiedComponents.push(id);
        } else {
          throw err;
        }
      }
    });
  }
  const idsToRemove = force ? bitIds : nonModifiedComponents;
  const componentsList = new ComponentsList(consumer);
  const newComponents = (await componentsList.listNewComponents(false)) as ComponentIdList;
  const idsToRemoveFromScope = ComponentIdList.fromArray(
    idsToRemove.filter((id) => !newComponents.hasWithoutVersion(id))
  );
  const idsToCleanFromWorkspace = ComponentIdList.fromArray(
    idsToRemove.filter((id) => newComponents.hasWithoutVersion(id))
  );
  const { components: componentsToRemove, invalidComponents } = await consumer.loadComponents(idsToRemove, false);
  const { removedComponentIds, missingComponents, dependentBits, removedFromLane } = await consumer.scope.removeMany(
    idsToRemoveFromScope,
    force,
    consumer
  );
  // otherwise, components should still be in .bitmap file
  idsToCleanFromWorkspace.push(...removedComponentIds);
  if (idsToCleanFromWorkspace.length) {
    if (deleteFiles) await deleteComponentsFiles(consumer, idsToCleanFromWorkspace);
    if (!track) {
      const invalidComponentsIds = invalidComponents.map((i) => i.id);
      const removedComponents = componentsToRemove.filter((c) => idsToCleanFromWorkspace.hasWithoutVersion(c.id));
      await packageJsonUtils.removeComponentsFromWorkspacesAndDependencies(
        consumer,
        removedComponents,
        invalidComponentsIds
      );
      await consumer.cleanFromBitMap(idsToCleanFromWorkspace);
    }
  }
  return new RemovedLocalObjects(
    ComponentIdList.uniqFromArray([...idsToCleanFromWorkspace, ...removedComponentIds]),
    missingComponents,
    modifiedComponents,
    dependentBits,
    removedFromLane
  );
}

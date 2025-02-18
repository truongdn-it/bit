import forEachObjIndexed from 'ramda/src/forEachObjIndexed';
import pick from 'ramda/src/pick';
import omit from 'ramda/src/omit';
import { LIFECYCLE_TYPE_BY_KEY_NAME } from '../../dependencies/constants';
import { ManifestDependenciesKeysNames, DepObjectValue } from '../manifest';
import { DependencyLifecycleType, SemverVersion, PackageName } from '../../dependencies';
import { ComponentDependenciesMap } from '../workspace-manifest-factory';
import { WorkspacePolicy } from '../../policy';

export type PackageNameIndexItem = {
  metadata: PackageNameIndexItemMetadata;
  componentItems: PackageNameIndexComponentItem[];
};

export type PackageNameIndexItemMetadata = {
  preservedVersion?: string;
  preservedLifecycleType?: DependencyLifecycleType;
};

export type PackageNameIndexComponentItem = {
  range: SemverVersion;
  origin: PackageName;
  lifecycleType: DependencyLifecycleType;
};

export type PackageNameIndex = Map<PackageName, PackageNameIndexItem>;

/**
 * This will get the map of dependencies for each component and will create a new index with the dependencyId (package name) as key
 * and all components / ranges as value
 * It used as a pre processing as part of the deduping process
 *
 * @param {ComponentDependenciesMap} componentDependenciesMap
 * @returns {PackageNameIndex}
 */
export function indexByDepId(
  rootPolicy: WorkspacePolicy,
  componentDependenciesMap: ComponentDependenciesMap,
  hoistedDepFields?: ManifestDependenciesKeysNames[]
): PackageNameIndex {
  const result: PackageNameIndex = new Map();
  componentDependenciesMap.forEach((depsObject, compPackageName) => {
    if (hoistedDepFields) {
      depsObject = pick(hoistedDepFields, depsObject);
    } else {
      depsObject = omit(['peerDependenciesMeta'], depsObject);
    }
    forEachObjIndexed(addSpecificLifeCycleDepsToIndex(result, compPackageName), depsObject);
  });
  addPreservedFromRoot(result, rootPolicy);
  return result;
}

function addPreservedFromRoot(index: PackageNameIndex, rootPolicy: WorkspacePolicy): void {
  const preserved = rootPolicy.filter((entry) => !!entry.value.preserve);
  preserved.forEach((entry) => {
    const metadata: PackageNameIndexItemMetadata = {
      preservedVersion: entry.value.version,
      preservedLifecycleType: entry.lifecycleType,
    };
    setMetadataToExistingIndexItem(index, entry.dependencyId, metadata);
  });
}

function setMetadataToExistingIndexItem(
  index: PackageNameIndex,
  depId: PackageName,
  metadata: PackageNameIndexItemMetadata
): void {
  const existingItem = index.get(depId);
  // only change existing items
  if (existingItem) {
    existingItem.metadata = metadata;
  }
}

/**
 * Mutate the index and add all deps from specific lifecycle type to the index
 *
 * @param {PackageNameIndex} index
 * @param {PackageName} origin
 * @returns
 */
function addSpecificLifeCycleDepsToIndex(index: PackageNameIndex, origin: PackageName) {
  return (deps: DepObjectValue, depKeyName: ManifestDependenciesKeysNames) => {
    const lifecycleType = LIFECYCLE_TYPE_BY_KEY_NAME[depKeyName] as DependencyLifecycleType;
    forEachObjIndexed(addComponentDepToDepIdIndex(index, origin, lifecycleType), deps);
  };
}

/**
 * Mutate the index and add specific package into it
 *
 * @param {PackageNameIndex} index
 * @param {PackageName} origin
 * @param {DependencyLifecycleType} lifecycleType
 * @returns
 */
function addComponentDepToDepIdIndex(
  index: PackageNameIndex,
  origin: PackageName,
  lifecycleType: DependencyLifecycleType
) {
  return (range: SemverVersion, depId: PackageName) => {
    const componentItem: PackageNameIndexComponentItem = {
      origin,
      range,
      lifecycleType,
    };
    if (!index.has(depId)) {
      const item: PackageNameIndexItem = {
        componentItems: [componentItem],
        metadata: {},
      };
      index.set(depId, item);
      return;
    }
    index.get(depId)?.componentItems.push(componentItem);
  };
}

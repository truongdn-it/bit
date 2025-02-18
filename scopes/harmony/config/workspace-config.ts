import { DEFAULT_LANGUAGE, WORKSPACE_JSONC } from '@teambit/legacy/dist/constants';
import { AbstractVinyl } from '@teambit/legacy/dist/consumer/component/sources';
import DataToPersist from '@teambit/legacy/dist/consumer/component/sources/data-to-persist';
import { ExtensionDataList, ILegacyWorkspaceConfig } from '@teambit/legacy/dist/consumer/config';
import LegacyWorkspaceConfig, {
  WorkspaceConfigProps as LegacyWorkspaceConfigProps,
} from '@teambit/legacy/dist/consumer/config/workspace-config';
import logger from '@teambit/legacy/dist/logger/logger';
import { PathOsBased, PathOsBasedAbsolute } from '@teambit/legacy/dist/utils/path';
import { currentDateAndTimeToFileName } from '@teambit/legacy/dist/consumer/consumer';
import { assign, parse, stringify, CommentJSONValue } from 'comment-json';
import * as fs from 'fs-extra';
import * as path from 'path';
import { isEmpty, omit } from 'lodash';
import WorkspaceAspect from '@teambit/workspace';
import { SetExtensionOptions } from './config.main.runtime';
import { ExtensionAlreadyConfigured } from './exceptions';
import InvalidConfigFile from './exceptions/invalid-config-file';
import { HostConfig } from './types';

const INTERNAL_CONFIG_PROPS = ['$schema', '$schemaVersion'];

export type LegacyInitProps = {
  standAlone?: boolean;
};

export type WorkspaceConfigFileProps = {
  // TODO: make it no optional
  $schema?: string;
  $schemaVersion?: string;
} & ExtensionsDefs;

export type ComponentScopeDirMapEntry = {
  defaultScope?: string;
  directory: string;
};

export type ComponentScopeDirMap = Array<ComponentScopeDirMapEntry>;

export type WorkspaceExtensionProps = {
  defaultScope?: string;
  defaultDirectory?: string;
  components?: ComponentScopeDirMap;
};

export type PackageManagerClients = 'npm' | 'yarn' | undefined;

export interface DependencyResolverExtensionProps {
  packageManager: PackageManagerClients;
  strictPeerDependencies?: boolean;
  extraArgs?: string[];
  packageManagerProcessOptions?: any;
  useWorkspaces?: boolean;
  manageWorkspaces?: boolean;
}

export type WorkspaceSettingsNewProps = {
  'teambit.workspace/workspace': WorkspaceExtensionProps;
  'teambit.dependencies/dependency-resolver': DependencyResolverExtensionProps;
};

export type WorkspaceLegacyProps = {
  dependenciesDirectory?: string;
  saveDependenciesAsComponents?: boolean;
};

export type ExtensionsDefs = WorkspaceSettingsNewProps;

export class WorkspaceConfig implements HostConfig {
  raw?: any;
  _extensions: ExtensionDataList;
  _legacyProps?: WorkspaceLegacyProps;
  isLegacy: boolean;

  constructor(
    private data: WorkspaceConfigFileProps,
    private _path: PathOsBasedAbsolute,
    private scopePath?: PathOsBasedAbsolute
  ) {
    this.raw = data;
    this.loadExtensions();
  }

  get path(): PathOsBased {
    return this._path;
  }

  get extensions(): ExtensionDataList {
    return this._extensions;
  }

  private loadExtensions() {
    const withoutInternalConfig = omit(this.raw, INTERNAL_CONFIG_PROPS);
    this._extensions = ExtensionDataList.fromConfigObject(withoutInternalConfig);
  }

  extension(extensionId: string, ignoreVersion: boolean): any {
    const existing = this.extensions.findExtension(extensionId, ignoreVersion);
    return existing?.config;
  }

  setExtension(extensionId: string, config: Record<string, any>, options: SetExtensionOptions): any {
    const existing = this.extension(extensionId, options.ignoreVersion);
    if (existing) {
      if (options.mergeIntoExisting) {
        config = { ...existing, ...config };
      } else if (!options.overrideExisting) {
        throw new ExtensionAlreadyConfigured(extensionId);
      }
    }

    this.raw[extensionId] = config;
    this.loadExtensions();
  }

  renameExtensionInRaw(oldExtId: string, newExtId: string): boolean {
    if (this.raw[oldExtId]) {
      this.raw[newExtId] = this.raw[oldExtId];
      delete this.raw[oldExtId];
      return true;
    }
    return false;
  }

  /**
   * Create an instance of the WorkspaceConfig by data
   *
   * @static
   * @param {WorkspaceConfigFileProps} data
   * @returns
   * @memberof WorkspaceConfig
   */
  static fromObject(data: WorkspaceConfigFileProps, workspaceJsoncPath: PathOsBased, scopePath?: PathOsBasedAbsolute) {
    return new WorkspaceConfig(data, workspaceJsoncPath, scopePath);
  }

  /**
   * Create an instance of the WorkspaceConfig by the workspace config template and override values
   *
   * @static
   * @param {WorkspaceConfigFileProps} data values to override in the default template
   * @returns
   * @memberof WorkspaceConfig
   */
  static async create(props: WorkspaceConfigFileProps, dirPath: PathOsBasedAbsolute, scopePath: PathOsBasedAbsolute) {
    const template = await getWorkspaceConfigTemplateParsed();
    // previously, we just did `assign(template, props)`, but it was replacing the entire workspace config with the "props".
    // so for example, if the props only had defaultScope, it was removing the defaultDirectory.
    const workspaceAspectConf = assign(template[WorkspaceAspect.id], props[WorkspaceAspect.id]);
    const merged = assign(template, { [WorkspaceAspect.id]: workspaceAspectConf });
    return new WorkspaceConfig(merged, WorkspaceConfig.composeWorkspaceJsoncPath(dirPath), scopePath);
  }

  /**
   * Ensure the given directory has a workspace config
   * Load if existing and create new if not
   *
   * @static
   * @param {PathOsBasedAbsolute} dirPath
   * @param {WorkspaceConfigFileProps} [workspaceConfigProps={} as any]
   * @returns {Promise<WorkspaceConfig>}
   * @memberof WorkspaceConfig
   */
  static async ensure(
    dirPath: PathOsBasedAbsolute,
    scopePath: PathOsBasedAbsolute,
    workspaceConfigProps: WorkspaceConfigFileProps = {} as any
  ): Promise<WorkspaceConfig> {
    try {
      let workspaceConfig = await this.loadIfExist(dirPath, scopePath);
      if (workspaceConfig) {
        return workspaceConfig;
      }
      workspaceConfig = await this.create(workspaceConfigProps, dirPath, scopePath);
      return workspaceConfig;
    } catch (err: any) {
      if (err instanceof InvalidConfigFile) {
        const workspaceConfig = this.create(workspaceConfigProps, dirPath, scopePath);
        return workspaceConfig;
      }
      throw err;
    }
  }

  static async reset(dirPath: PathOsBasedAbsolute, resetHard: boolean): Promise<void> {
    const workspaceJsoncPath = WorkspaceConfig.composeWorkspaceJsoncPath(dirPath);
    if (resetHard && workspaceJsoncPath) {
      logger.info(`deleting the consumer workspace.jsonc file at ${workspaceJsoncPath}`);
      await fs.remove(workspaceJsoncPath);
    }
  }

  /**
   * Get the path of the workspace.jsonc file by a containing folder
   *
   * @static
   * @param {PathOsBased} dirPath containing dir of the workspace.jsonc file
   * @returns {PathOsBased}
   * @memberof WorkspaceConfig
   */
  static composeWorkspaceJsoncPath(dirPath: PathOsBased): PathOsBased {
    return path.join(dirPath, WORKSPACE_JSONC);
  }

  static async pathHasWorkspaceJsonc(dirPath: PathOsBased): Promise<boolean> {
    const isExist = await fs.pathExists(WorkspaceConfig.composeWorkspaceJsoncPath(dirPath));
    return isExist;
  }

  /**
   * Check if the given dir has workspace config (new or legacy)
   * @param dirPath
   */
  static async isExist(dirPath: PathOsBased): Promise<boolean | undefined> {
    const jsoncExist = await WorkspaceConfig.pathHasWorkspaceJsonc(dirPath);
    if (jsoncExist) {
      return true;
    }
    return LegacyWorkspaceConfig._isExist(dirPath);
  }

  /**
   * Load the workspace configuration if it's exist
   *
   * @static
   * @param {PathOsBased} dirPath
   * @returns {(Promise<WorkspaceConfig | undefined>)}
   * @memberof WorkspaceConfig
   */
  static async loadIfExist(
    dirPath: PathOsBased,
    scopePath?: PathOsBasedAbsolute
  ): Promise<WorkspaceConfig | undefined> {
    const jsoncExist = await WorkspaceConfig.pathHasWorkspaceJsonc(dirPath);
    if (jsoncExist) {
      const jsoncPath = WorkspaceConfig.composeWorkspaceJsoncPath(dirPath);
      const instance = await WorkspaceConfig._loadFromWorkspaceJsonc(jsoncPath, scopePath);
      return instance;
    }
    return undefined;
  }

  static async _loadFromWorkspaceJsonc(workspaceJsoncPath: PathOsBased, scopePath?: string): Promise<WorkspaceConfig> {
    const contentBuffer = await fs.readFile(workspaceJsoncPath);
    let parsed;
    try {
      parsed = parse(contentBuffer.toString());
    } catch (e: any) {
      throw new InvalidConfigFile(workspaceJsoncPath);
    }
    return WorkspaceConfig.fromObject(parsed, workspaceJsoncPath, scopePath);
  }

  async write({ dir, reasonForChange }: { dir?: PathOsBasedAbsolute; reasonForChange?: string } = {}): Promise<void> {
    const getCalculatedDir = () => {
      if (dir) return dir;
      return path.dirname(this._path);
    };
    const calculatedDir = getCalculatedDir();
    const files = await this.toVinyl(calculatedDir);
    const dataToPersist = new DataToPersist();
    if (files) {
      dataToPersist.addManyFiles(files);
      await this.backupConfigFile(reasonForChange);
      await dataToPersist.persistAllToFS();
    }
  }

  private async backupConfigFile(reasonForChange?: string) {
    if (!this.scopePath) {
      logger.error(`unable to backup workspace.jsonc file without scope path`);
      return;
    }
    try {
      const baseDir = this.getBackupHistoryDir();
      await fs.ensureDir(baseDir);
      const fileId = currentDateAndTimeToFileName();
      const backupPath = path.join(baseDir, fileId);
      await fs.copyFile(this._path, backupPath);
      const metadataFile = this.getBackupMetadataFilePath();
      await fs.appendFile(metadataFile, `${fileId} ${reasonForChange || ''}\n`);
    } catch (err: any) {
      if (err.code === 'ENOENT') return; // no such file or directory, meaning the .bitmap file doesn't exist (yet)
      // it's a nice to have feature. don't kill the process if something goes wrong.
      logger.error(`failed to backup workspace.jsonc`, err);
    }
  }
  private getBackupDir() {
    if (!this.scopePath) throw new Error('unable to get backup dir without scope path');
    return path.join(this.scopePath, 'workspace-config-history');
  }
  getBackupHistoryDir() {
    return path.join(this.getBackupDir(), 'files');
  }
  getBackupMetadataFilePath() {
    return path.join(this.getBackupDir(), 'metadata.txt');
  }
  private async getParsedHistoryMetadata(): Promise<{ [fileId: string]: string }> {
    let fileContent: string | undefined;
    try {
      fileContent = await fs.readFile(this.getBackupMetadataFilePath(), 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return {}; // no such file or directory, meaning the history-metadata file doesn't exist (yet)
    }
    const lines = fileContent?.split('\n') || [];
    const metadata = {};
    lines.forEach((line) => {
      const [fileId, ...reason] = line.split(' ');
      if (!fileId) return;
      metadata[fileId] = reason.join(' ');
    });
    return metadata;
  }

  async toVinyl(workspaceDir: PathOsBasedAbsolute): Promise<AbstractVinyl[] | undefined> {
    const jsonStr = `${stringify(this.data, undefined, 2)}\n`;
    const base = workspaceDir;
    const fullPath = workspaceDir ? WorkspaceConfig.composeWorkspaceJsoncPath(workspaceDir) : this.path;
    const jsonFile = new AbstractVinyl({ base, path: fullPath, contents: Buffer.from(jsonStr) });
    return [jsonFile];
  }

  toLegacy(): ILegacyWorkspaceConfig {
    let componentsDefaultDirectory = this.extension('teambit.workspace/workspace', true)?.defaultDirectory;
    if (componentsDefaultDirectory && !componentsDefaultDirectory.includes('{name}')) {
      componentsDefaultDirectory = `${componentsDefaultDirectory}/{name}`;
    }

    return {
      lang: DEFAULT_LANGUAGE,
      defaultScope: this.extension('teambit.workspace/workspace', true)?.defaultScope,
      _useWorkspaces: this.extension('teambit.dependencies/dependency-resolver', true)?.useWorkspaces,
      dependencyResolver: this.extension('teambit.dependencies/dependency-resolver', true),
      packageManager: this.extension('teambit.dependencies/dependency-resolver', true)?.packageManager,
      _saveDependenciesAsComponents: this._legacyProps?.saveDependenciesAsComponents,
      _dependenciesDirectory: this._legacyProps?.dependenciesDirectory,
      componentsDefaultDirectory,
      _manageWorkspaces: this.extension('teambit.dependencies/dependency-resolver', true)?.manageWorkspaces,
      extensions: this.extensions.toConfigObject(),
      // @ts-ignore
      path: this.path,
      isLegacy: false,
      write: ({ workspaceDir }) => this.write.call(this, { dir: workspaceDir }),
      toVinyl: this.toVinyl.bind(this),
      _legacyPlainObject: () => undefined,
    };
  }
}

export function transformLegacyPropsToExtensions(
  legacyConfig: LegacyWorkspaceConfig | LegacyWorkspaceConfigProps
): ExtensionsDefs {
  // TODO: move to utils
  const removeUndefined = (obj) => {
    // const res = omit(mapObjIndexed((val) => val === undefined))(obj);
    // return res;
    Object.entries(obj).forEach((e) => {
      if (e[1] === undefined) delete obj[e[0]];
    });
    return obj;
  };

  const workspace = removeUndefined({
    defaultScope: legacyConfig.defaultScope,
    defaultDirectory: legacyConfig.componentsDefaultDirectory,
  });
  const dependencyResolver = removeUndefined({
    packageManager: legacyConfig.packageManager,
    // strictPeerDependencies: false,
    extraArgs: legacyConfig.packageManagerArgs,
    packageManagerProcessOptions: legacyConfig.packageManagerProcessOptions,
    manageWorkspaces: legacyConfig.manageWorkspaces,
    useWorkspaces: legacyConfig.useWorkspaces,
  });
  const data = {};
  if (workspace && !isEmpty(workspace)) {
    data['teambit.workspace/workspace'] = workspace;
  }
  if (dependencyResolver && !isEmpty(dependencyResolver)) {
    data['teambit.dependencies/dependency-resolver'] = dependencyResolver;
  }
  // @ts-ignore
  return data;
}

export async function getWorkspaceConfigTemplateParsed(): Promise<CommentJSONValue> {
  let fileContent: Buffer;
  try {
    fileContent = await fs.readFile(path.join(__dirname, 'workspace-template.jsonc'));
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    // when the extension is compiled by tsc, it doesn't copy .jsonc files into the dists, grab it from src
    fileContent = await fs.readFile(path.join(__dirname, '..', 'workspace-template.jsonc'));
  }
  return parse(fileContent.toString());
}

export function stringifyWorkspaceConfig(workspaceConfig: CommentJSONValue): string {
  return stringify(workspaceConfig, undefined, 2);
}

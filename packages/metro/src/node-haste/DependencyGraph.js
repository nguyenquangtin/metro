/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 * @format
 */

'use strict';

const AssetResolutionCache = require('./AssetResolutionCache');
const DependencyGraphHelpers = require('./DependencyGraph/DependencyGraphHelpers');
const FilesByDirNameIndex = require('./FilesByDirNameIndex');
const JestHasteMap = require('jest-haste-map');
const Module = require('./Module');
const ModuleCache = require('./ModuleCache');
const ResolutionRequest = require('./DependencyGraph/ResolutionRequest');

const fs = require('fs');
const parsePlatformFilePath = require('./lib/parsePlatformFilePath');
const path = require('path');
const toLocalPath = require('../node-haste/lib/toLocalPath');

const {ModuleResolver} = require('./DependencyGraph/ModuleResolution');
const {EventEmitter} = require('events');
const {
  Logger: {createActionStartEntry, createActionEndEntry, log},
} = require('metro-core');

import type {Options as JSTransformerOptions} from '../JSTransformer/worker';
import type {GlobalTransformCache} from '../lib/GlobalTransformCache';
import type {
  GetTransformCacheKey,
  TransformCache,
} from '../lib/TransformCaching';
import type {Reporter} from '../lib/reporting';
import type {ModuleMap} from './DependencyGraph/ModuleResolution';
import type {TransformCode} from './Module';
import type Package from './Package';
import type {HasteFS} from './types';
import type {CustomResolver} from 'metro-resolver';

type Options = {|
  +assetExts: Array<string>,
  +assetRegistryPath: string,
  +blacklistRE?: RegExp,
  +experimentalCaches: boolean,
  +extraNodeModules: ?{},
  +getPolyfills: ({platform: ?string}) => $ReadOnlyArray<string>,
  +getTransformCacheKey: GetTransformCacheKey,
  +globalTransformCache: ?GlobalTransformCache,
  +hasteImplModulePath?: string,
  +maxWorkers: number,
  +platforms: Set<string>,
  +polyfillModuleNames?: Array<string>,
  +projectRoots: $ReadOnlyArray<string>,
  +providesModuleNodeModules: Array<string>,
  +reporter: Reporter,
  +resetCache: boolean,
  +resolveRequest: ?CustomResolver,
  +sourceExts: Array<string>,
  +transformCache: TransformCache,
  +transformCode: TransformCode,
  +watch: boolean,
|};

const JEST_HASTE_MAP_CACHE_BREAKER = 3;

class DependencyGraph extends EventEmitter {
  _assetResolutionCache: AssetResolutionCache;
  _filesByDirNameIndex: FilesByDirNameIndex;
  _haste: JestHasteMap;
  _hasteFS: HasteFS;
  _helpers: DependencyGraphHelpers;
  _moduleCache: ModuleCache;
  _moduleMap: ModuleMap;
  _moduleResolver: ModuleResolver<Module, Package>;
  _opts: Options;

  constructor(config: {|
    +opts: Options,
    +haste: JestHasteMap,
    +initialHasteFS: HasteFS,
    +initialModuleMap: ModuleMap,
  |}) {
    super();
    this._opts = config.opts;
    this._filesByDirNameIndex = new FilesByDirNameIndex(
      config.initialHasteFS.getAllFiles(),
    );
    this._assetResolutionCache = new AssetResolutionCache({
      assetExtensions: new Set(config.opts.assetExts),
      getDirFiles: dirPath => this._filesByDirNameIndex.getAllFiles(dirPath),
      platforms: config.opts.platforms,
    });
    this._haste = config.haste;
    this._hasteFS = config.initialHasteFS;
    this._moduleMap = config.initialModuleMap;
    this._helpers = new DependencyGraphHelpers(this._opts);
    this._haste.on('change', this._onHasteChange.bind(this));
    this._moduleCache = this._createModuleCache();
    this._createModuleResolver();
  }

  static _createHaste(
    opts: Options,
    useWatchman?: boolean = true,
  ): JestHasteMap {
    return new JestHasteMap({
      computeSha1: true,
      extensions: opts.sourceExts.concat(opts.assetExts),
      forceNodeFilesystemAPI: !useWatchman,
      hasteImplModulePath: opts.hasteImplModulePath,
      ignorePattern: opts.blacklistRE || / ^/,
      maxWorkers: opts.maxWorkers,
      mocksPattern: '',
      name: 'metro-' + JEST_HASTE_MAP_CACHE_BREAKER,
      platforms: Array.from(opts.platforms),
      providesModuleNodeModules: opts.providesModuleNodeModules,
      resetCache: opts.resetCache,
      retainAllFiles: true,
      roots: opts.projectRoots,
      throwOnModuleCollision: true,
      useWatchman,
      watch: opts.watch,
    });
  }

  static _getJestHasteMapOptions(opts: Options) {}

  static async load(
    opts: Options,
    useWatchman?: boolean = true,
  ): Promise<DependencyGraph> {
    const initializingMetroLogEntry = log(
      createActionStartEntry('Initializing Metro'),
    );

    opts.reporter.update({type: 'dep_graph_loading'});
    const haste = DependencyGraph._createHaste(opts, useWatchman);
    const {hasteFS, moduleMap} = await haste.build();

    log(createActionEndEntry(initializingMetroLogEntry));
    opts.reporter.update({type: 'dep_graph_loaded'});

    return new DependencyGraph({
      haste,
      initialHasteFS: hasteFS,
      initialModuleMap: moduleMap,
      opts,
    });
  }

  _getClosestPackage(filePath: string): ?string {
    const parsedPath = path.parse(filePath);
    const root = parsedPath.root;
    let dir = parsedPath.dir;
    do {
      const candidate = path.join(dir, 'package.json');
      if (this._hasteFS.exists(candidate)) {
        return candidate;
      }
      dir = path.dirname(dir);
    } while (dir !== '.' && dir !== root);
    return null;
  }

  _onHasteChange({eventsQueue, hasteFS, moduleMap}) {
    this._hasteFS = hasteFS;
    this._filesByDirNameIndex = new FilesByDirNameIndex(hasteFS.getAllFiles());
    this._assetResolutionCache.clear();
    this._moduleMap = moduleMap;
    eventsQueue.forEach(({type, filePath}) =>
      this._moduleCache.processFileChange(type, filePath),
    );
    this._createModuleResolver();
    this.emit('change');
  }

  _createModuleResolver() {
    this._moduleResolver = new ModuleResolver({
      dirExists: filePath => {
        try {
          return fs.lstatSync(filePath).isDirectory();
        } catch (e) {}
        return false;
      },
      doesFileExist: this._doesFileExist,
      extraNodeModules: this._opts.extraNodeModules,
      isAssetFile: filePath => this._helpers.isAssetFile(filePath),
      moduleCache: this._moduleCache,
      moduleMap: this._moduleMap,
      preferNativePlatform: true,
      resolveAsset: (dirPath, assetName, platform) =>
        this._assetResolutionCache.resolve(dirPath, assetName, platform),
      resolveRequest: this._opts.resolveRequest,
      sourceExts: this._opts.sourceExts,
    });
  }

  _createModuleCache() {
    const {_opts} = this;
    return new ModuleCache(
      {
        assetDependencies: [_opts.assetRegistryPath],
        depGraphHelpers: this._helpers,
        experimentalCaches: _opts.experimentalCaches,
        getClosestPackage: this._getClosestPackage.bind(this),
        getTransformCacheKey: _opts.getTransformCacheKey,
        globalTransformCache: _opts.globalTransformCache,
        hasteImplModulePath: _opts.hasteImplModulePath,
        resetCache: _opts.resetCache,
        transformCache: _opts.transformCache,
        reporter: _opts.reporter,
        roots: _opts.projectRoots,
        transformCode: _opts.transformCode,
      },
      _opts.platforms,
    );
  }

  /**
   * Returns a promise with the direct dependencies the module associated to
   * the given entryPath has.
   */
  async getShallowDependencies(
    entryPath: string,
    transformOptions: JSTransformerOptions,
  ): Promise<$ReadOnlyArray<string>> {
    const module = this._moduleCache.getModule(entryPath);
    const result = await module.read(transformOptions);

    return result.dependencies;
  }

  getSha1(filename: string): string {
    // $FlowFixMe: TODO T27501330: Use getSha1 from HasteFS.
    const file = this._hasteFS._files[filename];

    if (!file) {
      throw new ReferenceError(`File ${filename} is not tracked by haste-map`);
    }

    const sha1 = file[4];

    if (!sha1) {
      throw new ReferenceError(`SHA-1 for file ${filename} is not computed`);
    }

    return sha1;
  }

  getWatcher() {
    return this._haste;
  }

  end() {
    this._haste.end();
  }

  getModuleForPath(entryFile: string, isPolyfill: boolean): Module {
    if (isPolyfill) {
      return this._moduleCache.getPolyfillModule(entryFile);
    }

    if (this._helpers.isAssetFile(entryFile)) {
      return this._moduleCache.getAssetModule(entryFile);
    }

    return this._moduleCache.getModule(entryFile);
  }

  resolveDependency(
    fromModule: Module,
    toModuleName: string,
    platform: ?string,
  ): Module {
    const req = new ResolutionRequest({
      moduleResolver: this._moduleResolver,
      entryPath: fromModule.path,
      helpers: this._helpers,
      platform: platform || null,
      moduleCache: this._moduleCache,
    });

    return req.resolveDependency(fromModule, toModuleName);
  }

  _doesFileExist = (filePath: string): boolean => {
    return this._hasteFS.exists(filePath);
  };

  _getRequestPlatform(entryPath: string, platform: ?string): ?string {
    if (platform == null) {
      platform = parsePlatformFilePath(entryPath, this._opts.platforms)
        .platform;
    } else if (!this._opts.platforms.has(platform)) {
      throw new Error('Unrecognized platform: ' + platform);
    }
    return platform;
  }

  getHasteName(filePath: string): string {
    const hasteName = this._hasteFS.getModuleName(filePath);

    if (hasteName) {
      return hasteName;
    }

    return toLocalPath(this._opts.projectRoots, filePath);
  }

  createPolyfill(options: {file: string}) {
    return this._moduleCache.createPolyfill(options);
  }
}

module.exports = DependencyGraph;

import { Module, auto, ExpressionRef, none, createType, Type, i32, i64, f32, f64 } from 'binaryen';
import {
  Callable,
  LibFunc,
  Lib,
  Esential,
  Dict,
  MemDef,
  IndirectInfo,
  FuncDef,
  Initializer,
  ExternalDef,
  Ref,
  TypeDef,
} from './types';
import { CompileOptions } from './types';
import { getResultFunc, getExecFunc, getBlockFunc, getCallable } from './funcs';
import { getVarsProxy } from './vars';
import { FEATURE_MULTIVALUE } from './constants';
import { asType, setTypeDef } from './typedefs';

export type Imports = Dict<Dict<any>>;

export const getFunc = (
  module: Module,
  callableIdMap: Map<Callable, string>,
  exportedSet: Set<Callable>,
  indirectTable?: IndirectInfo[],
) => (def: FuncDef, initializer: Initializer): Callable => {
  const count = callableIdMap.size;
  const {
    id = `indirect${count}`,
    params = {},
    result = auto,
    locals = {},
    export: exported = true,
  } = def;
  const bodyItems: ExpressionRef[] = [];
  const vars = { ...params, ...locals };
  const varsProxy = getVarsProxy(module, vars, bodyItems);
  const resultRef: Ref<TypeDef> = { current: result };
  const resultFunc = getResultFunc(module, resultRef, bodyItems);
  const blockFunc = getBlockFunc(module);
  const execFunc = getExecFunc(module, bodyItems);
  initializer({ $: varsProxy, result: resultFunc, block: blockFunc, exec: execFunc });
  if (resultRef.current === auto) {
    resultRef.current = none;
  }
  const { length: paramsLength } = Object.values(params);
  const paramsType = createType(Object.values(params).map(asType));
  const resultType = asType(resultRef.current);
  const localTypes = Object.values(vars)
    .slice(paramsLength)
    .map(asType);
  module.addFunction(id, paramsType, resultType, localTypes, module.block(null as any, bodyItems));

  let exprFunc;
  if (indirectTable == null) {
    exprFunc = (...params: ExpressionRef[]) => module.call(id, params, resultType);
  } else {
    const { length: index } = indirectTable;
    indirectTable.push({ index, id, paramDefs: params, resultDef: resultRef.current });
    exprFunc = (...params: ExpressionRef[]) =>
      module.call_indirect(module.i32.const(index), params, paramsType, resultType);
  }
  return getCallable(id, exported, exprFunc, resultRef.current, callableIdMap, exportedSet);
};

export const getExternalFunc = (
  module: Module,
  callableIdMap: Map<Callable, string>,
  importsRef: Ref<Imports>,
) => (def: ExternalDef, fn: Function): Callable => {
  const count = callableIdMap.size;
  const {
    namespace = 'namespace',
    name = 'name',
    id = `external${count}`,
    params: paramDefs = {},
    result: resultDef = none,
  } = def;
  const paramsType = createType(Object.values(paramDefs).map(asType));
  const resultType = asType(resultDef);
  module.addFunctionImport(id, namespace, name, paramsType, resultType);
  importsRef.current = {
    ...importsRef.current,
    [namespace]: {
      ...importsRef.current[namespace],
      [name]: fn,
    },
  };
  const exprFunc = (...params: ExpressionRef[]) => module.call(id, params, resultType);
  return getCallable(id, false, exprFunc, resultDef, callableIdMap);
};

const exportFuncs = (
  module: Module,
  lib: Dict<any>,
  exportedSet: Set<Callable>,
  callableIdMap: Map<Callable, string>,
) => {
  Object.entries(lib).forEach(([externalName, callable]) => {
    if (exportedSet.has(callable)) {
      const internalName = callableIdMap.get(callable);
      if (internalName) {
        module.addFunctionExport(internalName, externalName);
        exportedSet.delete(callable);
      }
    }
  });
};

const getLiteral = (module: Module) => (value: number, type: Type = i32): ExpressionRef => {
  const opDict = {
    [i32]: module.i32,
    [i64]: module.i64,
    [f32]: module.f32,
    [f64]: module.f64,
  };
  if (type in opDict) {
    // override type checking because of error in type definition for i64.const
    const expr = (opDict[type] as any).const(value);
    setTypeDef(expr, type); // for primitives type = typeDef
    return expr;
  }
  throw new Error(`Can only use primtive types in val, not ${type}`);
};

export const esential = (): Esential => {
  const module = new Module();
  module.setFeatures(FEATURE_MULTIVALUE);
  module.autoDrop();

  const importsRef: Ref<Imports> = { current: {} };
  const callableIdMap = new Map<Callable, string>();
  const callableIndirectMap = new Map<Callable, IndirectInfo>();
  const libMap = new Map<LibFunc, Lib>();
  const exportedSet = new Set<Callable>();
  const indirectTable: IndirectInfo[] = [];

  const compile = (options: CompileOptions = { optimize: true, validate: true }): any => {
    const ids = indirectTable.map(item => item.id);
    const { length } = ids;
    (module.setFunctionTable as any)(length, length, ids); // because .d.ts is wrong
    if (options.optimize) module.optimize();
    if (options.validate && !module.validate()) throw new Error('validation error');
    return new WebAssembly.Module(module.emitBinary());
  };

  const load = (binary: Uint8Array): any => {
    const instance = new WebAssembly.Instance(binary, importsRef.current);
    return instance.exports;
  };

  const esen: Esential = {
    module,

    lib(libFunc: LibFunc, args: Dict<any> = {}) {
      if (libMap.has(libFunc)) {
        return libMap.get(libFunc);
      }
      const lib = libFunc(esen, args);
      exportFuncs(module, lib, exportedSet, callableIdMap);
      libMap.set(libFunc, lib);
      return lib;
    },

    memory(def: MemDef): any {
      const { namespace = 'namespace', name = 'name', initial = 10, maximum = 100 } = def;
      const memObj = new WebAssembly.Memory({
        initial,
        maximum,
      });
      importsRef.current = {
        ...importsRef.current,
        [namespace]: {
          ...importsRef.current[namespace],
          [name]: memObj,
        },
      };
      module.addMemoryImport('0', namespace, name);
      module.setMemory(initial, maximum, name);
    },

    func: getFunc(module, callableIdMap, exportedSet),
    indirect: getFunc(module, callableIdMap, exportedSet, indirectTable),
    external: getExternalFunc(module, callableIdMap, importsRef),

    getIndirectInfo(callable: Callable) {
      return callableIndirectMap.get(callable);
    },

    literal: getLiteral(module),
    compile,
    load,
    start(options?: CompileOptions) {
      return load(compile(options));
    },
  };
  return esen;
};
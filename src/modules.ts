import { Module, auto, ExpressionRef, none, createType, Type, i32, i64, f32, f64 } from 'binaryen';
import {
  Callable,
  LibFunc,
  Lib,
  EsentialDef,
  Dict,
  MemDef,
  IndirectInfo,
  updateFunc,
  FuncDef,
  Initializer,
  ExternalDef,
} from './types';
import { CompileOptions } from './types';
import { getResultFunc, getExecFunc, getBlockFunc, getCallable } from './funcs';
import { getVarsProxy } from './vars';
import { FEATURE_MULTIVALUE } from './constants';
import { asType, setTypeDef } from './typedefs';

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
  const resultRef = { current: result };
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
  updateImports: (fn: updateFunc<any>) => void,
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
  updateImports((imports: any) => ({
    ...imports,
    [namespace]: {
      ...imports[namespace],
      [name]: fn,
    },
  }));
  const exprFunc = (...params: ExpressionRef[]) => module.call(id, params, resultType);
  return getCallable(id, false, exprFunc, resultDef, callableIdMap);
};

export const Esential = (): EsentialDef => {
  const module = new Module();
  module.setFeatures(FEATURE_MULTIVALUE);
  module.autoDrop();

  let imports: Dict<Dict<any>> = {};
  const callableIdMap = new Map<Callable, string>();
  const callableIndirectMap = new Map<Callable, IndirectInfo>();
  const libMap = new Map<LibFunc, Lib>();
  const exportedSet = new Set<Callable>();
  const indirectTable: IndirectInfo[] = [];

  const updateImports = (fn: updateFunc<any>) => {
    imports = fn(imports);
  };

  const { emitText } = module;

  const compile = (options: CompileOptions = { optimize: true, validate: true }): any => {
    const ids = indirectTable.map(item => item.id);
    const { length } = ids;
    (module.setFunctionTable as any)(length, length, ids); // because .d.ts is wrong
    if (options.optimize) module.optimize();
    if (options.validate && !module.validate()) throw new Error('validation error');
    return new WebAssembly.Module(module.emitBinary());
  };

  const modDef: EsentialDef = {
    lib(libFunc: LibFunc, args: Dict<any> = {}) {
      if (libMap.has(libFunc)) {
        return libMap.get(libFunc);
      }
      const lib = libFunc(modDef, args);
      Object.entries(lib).forEach(([externalName, callable]) => {
        if (exportedSet.has(callable)) {
          const internalName = callableIdMap.get(callable);
          if (internalName) {
            module.addFunctionExport(internalName, externalName);
            exportedSet.delete(callable);
          }
        }
      });
      libMap.set(libFunc, lib);
      return lib;
    },

    memory(def: MemDef): any {
      const { namespace = 'namespace', name = 'name', initial = 10, maximum = 100 } = def;
      const memObj = new WebAssembly.Memory({
        initial,
        maximum,
      });
      imports = {
        ...imports,
        [namespace]: {
          ...imports[namespace],
          [name]: memObj,
        },
      };
      module.addMemoryImport('0', namespace, name);
      module.setMemory(initial, maximum, name);
    },

    func: getFunc(module, callableIdMap, exportedSet),
    indirect: getFunc(module, callableIdMap, exportedSet, indirectTable),
    external: getExternalFunc(module, callableIdMap, updateImports),

    compile,

    getIndirectInfo(callable: Callable) {
      return callableIndirectMap.get(callable);
    },

    module,

    literal(value: number, type: Type = i32): ExpressionRef {
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
    },

    start(options?: CompileOptions): any {
      const binary = compile(options);
      const instance = new WebAssembly.Instance(binary, imports);
      return instance.exports;
    },

    ...{ emitText },
  };
  return modDef;
};

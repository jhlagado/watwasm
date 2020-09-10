import {
  Expression,
  TypeDef,
  VoidBlockFunc,
  BlockFunc,
  Ref,
  Callable,
} from './types';

import { ExpressionRef, auto, Module } from 'binaryen';
import { getAssignable } from './vars';
import { inferTypeDef, setTypeDef, getTypeDef, asType } from './typedefs';
import { stripTupleProxy } from './tuples';

export const getExecFunc = (bodyItems: ExpressionRef[]): VoidBlockFunc => (
  ...expressions: Expression[]
) => {
  const exprs = expressions.map(getAssignable);
  const { length } = exprs;
  if (length === 0) {
    throw new Error(`Function must have at least one arg`);
  }
  bodyItems.push(...exprs);
};

export const getResultFunc = (
  module: Module,
  resultDefRef: Ref<TypeDef>,
  bodyItems: ExpressionRef[],
): VoidBlockFunc => (...expressions: Expression[]) => {
  const exprs = expressions.map(getAssignable);
  const { length } = exprs;
  if (length === 0) {
    throw new Error(`Result function must have at least one arg`);
  }
  bodyItems.push(...exprs.slice(0, -1));
  const [expr] = exprs.slice(-1);
  if (resultDefRef.current === auto) {
    const typeDef = inferTypeDef(stripTupleProxy(expr));
    if (typeDef == null) {
      throw new Error(`Couldn't infer ${expr}`);
    }
    setTypeDef(expr, typeDef);
    resultDefRef.current = typeDef;
  } else {
    const exprTypeDef = getTypeDef(expr);
    if (asType(exprTypeDef) != asType(resultDefRef.current)) {
      throw new Error(`Wrong return type, expected ${resultDefRef} and got ${exprTypeDef}`);
    }
  }
  bodyItems.push(module.return(expr));
};

export const getBlockFunc = (module: Module): BlockFunc => (...expressions: Expression[]) => {
  const { length } = expressions;
  if (length === 0) {
    throw new Error(`Block must have at least one item`);
  }
  const exprs = expressions.map(getAssignable);
  const [lastExpr] = exprs.slice(-1);
  const lastTypeDef = getTypeDef(lastExpr);
  const blk = module.block(null as any, exprs, asType(lastTypeDef));
  setTypeDef(blk, lastTypeDef);
  return blk;
};

export const getCallable = (
  id: string,
  exported: boolean,
  exprFunc: (...params: ExpressionRef[]) => ExpressionRef,
  resultDef: TypeDef,
  callableIdMap: Map<Callable, string>,
  exportedSet?: Set<Callable>,
) => {
  const callable = (...params: ExpressionRef[]) => {
    const expr = exprFunc(...params);
    setTypeDef(expr, resultDef);
    return expr;
  };
  callableIdMap.set(callable, id);
  if (exported && exportedSet) {
    exportedSet.add(callable);
  }
  return callable;
};

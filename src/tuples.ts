import { ExpressionRef } from 'binaryen';
import { TypeDef, TupleObj } from './types';
import { tuple } from './core';

const tupleProxies = new WeakSet();

export const makeTupleProxy = (
  expressionRef: ExpressionRef,
  typeDef: TypeDef,
): TupleObj => {
  const proxy = new Proxy(new Number(expressionRef), {
    get(target: any, prop: number | string) {
      if (prop === 'valueOf') {
        return () => expressionRef;
      } else if (Number.isInteger(typeDef)) {
        throw new Error(`Cannot index a primitive value`);
      } else if (Array.isArray(typeDef)) {
        const index = prop as number;
        if (index >= typeDef.length) {
          throw new Error(`Max tuple index should be ${typeDef.length} but received ${prop}`);
        }
        return tuple.extract(expressionRef, index);
      } else {
        const index = Object.keys(typeDef).indexOf(prop as string);
        if (index < 0) {
          throw new Error(`Could not find ${prop} in record`);
        }
        return tuple.extract(expressionRef, index);
      }
    },
  });
  tupleProxies.add(proxy);
  return proxy;
};

export const stripTupleProxy = (expressionRef: any) => {
  return tupleProxies.has(expressionRef as any)
    ? expressionRef.valueOf()
    : expressionRef;
};
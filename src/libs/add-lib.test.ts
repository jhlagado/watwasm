import { esential } from '../esential';
import { addLib } from './add-lib';

const { lib, start } = esential();
lib(addLib);
const exported = start();

it('should add 2 number', () => {
  expect(exported.addition(41, 1)).toBe(42);
});

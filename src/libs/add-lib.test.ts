import { Esential } from '../modules';
import { addLib } from './add-lib';

const { lib, start } = Esential();
lib(addLib);
const exported = start();

it('should add 2 number', () => {
  expect(exported.addition(41, 1)).toBe(42);
});

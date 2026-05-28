import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../utils/retry.js';

describe('retry', () => {
  it('يُعيد القيمة مباشرةً عند النجاح', async () => {
    const result = await retry(() => Promise.resolve(42));
    assert.equal(result, 42);
  });

  it('يُعيد المحاولة عند الفشل ويُعيد القيمة في النهاية', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 3) throw new Error('fail');
      return Promise.resolve('ok');
    };

    const result = await retry(fn, 3, 0);
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('يرمي الخطأ بعد استنزاف كل المحاولات', async () => {
    const fn = () => Promise.reject(new Error('always fails'));
    await assert.rejects(() => retry(fn, 2, 0), /always fails/);
  });
});

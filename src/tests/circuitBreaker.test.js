import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../utils/circuitBreaker.js';

describe('CircuitBreaker', () => {
  it('يبدأ في حالة CLOSED', () => {
    const cb = new CircuitBreaker();
    assert.equal(cb.state, 'CLOSED');
    assert.ok(cb.canExecute());
  });

  it('ينتقل لـ OPEN بعد بلوغ الحد', () => {
    const cb = new CircuitBreaker(3);
    cb.fail(); cb.fail(); cb.fail();
    assert.equal(cb.state, 'OPEN');
    assert.ok(!cb.canExecute());
  });

  it('ينتقل لـ HALF_OPEN بعد انتهاء وقت الانتظار', async () => {
    const cb = new CircuitBreaker(1, 50); // 50ms reset
    cb.fail();
    assert.equal(cb.state, 'OPEN');

    await new Promise(r => setTimeout(r, 60));
    assert.ok(cb.canExecute());
    assert.equal(cb.state, 'HALF_OPEN');
  });

  it('يعود لـ CLOSED بعد النجاح', () => {
    const cb = new CircuitBreaker(3);
    cb.fail(); cb.fail(); cb.fail();
    // محاكاة HALF_OPEN
    cb.nextAttempt = Date.now() - 1;
    cb.canExecute();
    cb.success();
    assert.equal(cb.state, 'CLOSED');
    assert.equal(cb.failures, 0);
  });

  it('getStatus يُعيد البيانات الصحيحة', () => {
    const cb = new CircuitBreaker(5);
    cb.fail();
    const status = cb.getStatus();
    assert.equal(status.state, 'CLOSED');
    assert.equal(status.failures, 1);
    assert.equal(status.nextAttempt, null);
  });
});

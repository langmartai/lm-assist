import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput, parseTsvLines } from '../desktop/service';
import { DesktopError } from '../desktop/types';

/**
 * service.validateInput enforces the computer-use validation semantics before an
 * action ever reaches a backend — required params named per action, text rejected
 * where it does not belong, ranges checked. Getting this wrong means a malformed
 * call synthesizes the wrong event on someone's live desktop.
 */

test('clicks require a coordinate', () => {
  assert.throws(() => validateInput({ action: 'left_click' }), (e: unknown) => e instanceof DesktopError && /coordinate .* required for left_click/.test((e as Error).message));
  const ok = validateInput({ action: 'left_click', coordinate: [10, 20] });
  assert.deepStrictEqual(ok.coordinate, [10, 20]);
});

test('left_click_drag requires start_coordinate and coordinate', () => {
  assert.throws(() => validateInput({ action: 'left_click_drag', coordinate: [5, 5] }), /start_coordinate .* required/);
  const ok = validateInput({ action: 'left_click_drag', start_coordinate: [1, 1], coordinate: [9, 9] });
  assert.deepStrictEqual(ok.startCoordinate, [1, 1]);
  assert.deepStrictEqual(ok.coordinate, [9, 9]);
});

test('type requires non-empty text; key/hold_key require a combo', () => {
  assert.throws(() => validateInput({ action: 'type' }), /text is required for type/);
  assert.throws(() => validateInput({ action: 'type', text: '' }), /text is required for type/);
  assert.throws(() => validateInput({ action: 'key' }), /required for key/);
  assert.throws(() => validateInput({ action: 'hold_key', text: '   ' }), /required for hold_key/);
  assert.strictEqual(validateInput({ action: 'type', text: 'hello' }).text, 'hello');
  assert.strictEqual(validateInput({ action: 'key', text: 'ctrl+s' }).text, 'ctrl+s');
});

test('scroll requires a valid direction and non-negative amount', () => {
  assert.throws(() => validateInput({ action: 'scroll' }), /scroll_direction .* required/);
  assert.throws(() => validateInput({ action: 'scroll', scroll_direction: 'sideways' }), /scroll_direction/);
  assert.throws(() => validateInput({ action: 'scroll', scroll_direction: 'down', scroll_amount: -1 }), /non-negative/);
  const ok = validateInput({ action: 'scroll', scroll_direction: 'down', scroll_amount: 3 });
  assert.strictEqual(ok.scrollDirection, 'down');
  assert.strictEqual(ok.scrollAmount, 3);
});

test('hold_key duration is bounded to [0,100] seconds', () => {
  assert.throws(() => validateInput({ action: 'hold_key', text: 'shift', duration: 500 }), /\[0,100\]/);
  assert.strictEqual(validateInput({ action: 'hold_key', text: 'shift', duration: 2 }).duration, 2);
});

test('a click MAY carry a modifier in text; mouse_move may NOT', () => {
  // modifier-click is legal (text = held modifier)
  assert.strictEqual(validateInput({ action: 'left_click', coordinate: [1, 2], text: 'shift' }).text, 'shift');
  // mouse_move rejects text
  assert.throws(() => validateInput({ action: 'mouse_move', coordinate: [1, 2], text: 'shift' }), /mouse_move does not accept text/);
});

test('unknown actions and malformed coordinates are refused', () => {
  assert.throws(() => validateInput({ action: 'press' }), /unknown action/);
  assert.throws(() => validateInput({ action: 'left_click', coordinate: [1.5, 2] as unknown as [number, number] }), /coordinate must be two integers/);
});

test('cursor_position needs nothing and rejects text', () => {
  const ok = validateInput({ action: 'cursor_position' });
  assert.strictEqual(ok.action, 'cursor_position');
  assert.throws(() => validateInput({ action: 'cursor_position', text: 'x' }), /does not accept text/);
});

test('parseTsvLines groups words into lines with union boxes, mean conf, conf filter', () => {
  // tesseract tsv: level page block par line word left top width height conf text
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t100\t50\t40\t12\t92\tSend',
    '5\t1\t1\t1\t1\t2\t145\t50\t30\t12\t88\tmail',   // same block.par.line -> joined
    '5\t1\t2\t1\t1\t1\t100\t80\t60\t12\t20\tInbox',  // below minConf -> dropped
    '5\t1\t3\t1\t1\t1\t400\t80\t50\t14\t95\tCompose',
  ].join('\n');
  const lines = parseTsvLines(tsv, 50);
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].text, 'Send mail');
  assert.strictEqual(lines[0].left, 100);          // union left
  assert.strictEqual(lines[0].width, 75);          // 145+30-100
  assert.strictEqual(lines[0].conf, 90);           // mean(92,88)
  assert.strictEqual(lines[1].text, 'Compose');
});

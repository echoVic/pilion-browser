import { describe, expect, it } from 'vitest';
import { PRESS_KEYS as browserKeys } from '../src/main/browser/types';
import { PRESS_KEYS as sharedKeys } from '../src/shared/press-keys';
import { PressKeySchema } from '../src/shared/contracts';

describe('press keys', () => {
  it('the browser layer, the contract and the CLI share one list', () => {
    // The same array, not an equal copy: a key added in one place cannot go missing in another.
    expect(browserKeys).toBe(sharedKeys);
    expect(PressKeySchema.options).toEqual([...sharedKeys]);
  });
});

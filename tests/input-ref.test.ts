/**
 * Tests for the input value ref pattern used in ChatInput
 *
 * This tests the fix for the stale closure bug where rapid keystrokes
 * were being dropped because the useInput callback had stale references
 * to the input value.
 */

import { describe, it, expect, vi } from 'vitest';

describe('Input value ref pattern', () => {
  /**
   * Simulates the ChatInput ref pattern:
   * - valueRef tracks the current value
   * - updateValue updates the ref immediately then calls onChange
   * - This ensures rapid calls see the correct accumulated value
   */
  function createInputHandler() {
    let valueRef = { current: '' };
    const onChangeCalls: string[] = [];

    const onChange = (newValue: string) => {
      onChangeCalls.push(newValue);
      // Note: In real React, this would trigger a re-render eventually,
      // but we're testing what happens BEFORE that re-render
    };

    const updateValue = (newValue: string) => {
      valueRef.current = newValue;  // Update ref FIRST (synchronous)
      onChange(newValue);            // Then notify parent (may batch)
    };

    // Simulate what happens in useInput callback
    const handleInput = (char: string) => {
      const currentValue = valueRef.current;
      updateValue(currentValue + char);
    };

    const handleBackspace = () => {
      const currentValue = valueRef.current;
      updateValue(currentValue.slice(0, -1));
    };

    return {
      valueRef,
      onChangeCalls,
      handleInput,
      handleBackspace,
      getValue: () => valueRef.current,
    };
  }

  it('should accumulate rapid keystrokes correctly', () => {
    const { handleInput, getValue, onChangeCalls } = createInputHandler();

    // Simulate typing "hello" rapidly (no React re-renders between)
    handleInput('h');
    handleInput('e');
    handleInput('l');
    handleInput('l');
    handleInput('o');

    // The ref should have the full string
    expect(getValue()).toBe('hello');

    // All onChange calls should show progressive accumulation
    expect(onChangeCalls).toEqual(['h', 'he', 'hel', 'hell', 'hello']);
  });

  it('should handle rapid backspaces correctly', () => {
    const { handleInput, handleBackspace, getValue } = createInputHandler();

    // Type "test"
    handleInput('t');
    handleInput('e');
    handleInput('s');
    handleInput('t');
    expect(getValue()).toBe('test');

    // Rapidly delete
    handleBackspace();
    handleBackspace();
    expect(getValue()).toBe('te');
  });

  it('should handle mixed typing and backspace', () => {
    const { handleInput, handleBackspace, getValue } = createInputHandler();

    // Type "helo" (typo)
    handleInput('h');
    handleInput('e');
    handleInput('l');
    handleInput('o');

    // Fix typo: backspace twice, type "llo"
    handleBackspace();
    handleBackspace();
    handleInput('l');
    handleInput('l');
    handleInput('o');

    expect(getValue()).toBe('hello');
  });

  it('should handle very rapid input (simulating fast typist)', () => {
    const { handleInput, getValue } = createInputHandler();

    // Simulate typing a longer phrase very quickly
    const phrase = 'The quick brown fox jumps over the lazy dog';
    for (const char of phrase) {
      handleInput(char);
    }

    expect(getValue()).toBe(phrase);
  });

  /**
   * This test demonstrates what would happen with the OLD buggy pattern
   * where we used the prop value directly instead of a ref
   */
  it('demonstrates the stale closure bug (what we fixed)', () => {
    let propValue = '';  // This would be the prop from React
    const onChangeCalls: string[] = [];

    const onChange = (newValue: string) => {
      onChangeCalls.push(newValue);
      // In real React, propValue would only update after re-render
      // which is TOO LATE for rapid keystrokes
    };

    // BUGGY pattern: using propValue directly
    const handleInputBuggy = (char: string) => {
      onChange(propValue + char);  // propValue is stale!
    };

    // Simulate rapid typing without re-renders updating propValue
    handleInputBuggy('h');  // '' + 'h' = 'h'
    handleInputBuggy('e');  // '' + 'e' = 'e' (propValue still '')
    handleInputBuggy('l');  // '' + 'l' = 'l' (propValue still '')

    // BUG: Each keystroke overwrote the previous because propValue was stale
    expect(onChangeCalls).toEqual(['h', 'e', 'l']);
    // The last call was 'l', not 'hel' - characters were LOST
  });
});

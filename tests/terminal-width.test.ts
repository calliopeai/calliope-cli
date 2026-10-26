import {expect,it} from 'vitest';
import React from 'react';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import {useTerminalWidth} from '../src/ui/state/use-terminal-width.js';

const pause=()=>new Promise(resolve=>setTimeout(resolve,30));
function Width(){return React.createElement(Text,{},`width=${useTerminalWidth()}`);}

it('uses and tracks the rendered stream dimensions and removes its resize listener',async()=>{
  const ui=render(React.createElement(Width));
  try{
    await pause();const listeners=ui.stdout.listenerCount('resize');
    Object.defineProperty(ui.stdout,'columns',{value:47,configurable:true});
    Object.defineProperty(ui.stdout,'rows',{value:20,configurable:true});ui.stdout.emit('resize');
    await pause();expect(ui.lastFrame()).toContain('width=47');
    Object.defineProperty(ui.stdout,'columns',{value:62,configurable:true});ui.stdout.emit('resize');
    await pause();expect(ui.lastFrame()).toContain('width=62');
    ui.unmount();await pause();expect(ui.stdout.listenerCount('resize')).toBeLessThan(listeners);
  }finally{ui.unmount();}
});

it('uses positive fallback dimensions when the rendered stream has no terminal size',async()=>{
  const ui=render(React.createElement(Width));
  try{
    Object.defineProperty(ui.stdout,'columns',{value:0,configurable:true});
    Object.defineProperty(ui.stdout,'rows',{value:0,configurable:true});ui.stdout.emit('resize');
    await pause();const match=ui.lastFrame()?.match(/width=(\d+)/);
    expect(match).not.toBeNull();expect(Number(match![1])).toBeGreaterThan(0);
  }finally{ui.unmount();}
});

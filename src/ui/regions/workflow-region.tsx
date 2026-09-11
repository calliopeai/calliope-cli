import React from 'react';
import {Box,Text} from 'ink';
import {workflowLines,type WorkflowSnapshot,type WorkflowHudMode} from '../workflow-progress.js';

export interface WorkflowRegionProps {workflows:WorkflowSnapshot[];mode:WorkflowHudMode;width:number}
export const WorkflowRegion=React.memo(function WorkflowRegion({workflows,mode,width}:WorkflowRegionProps){
  const lines=workflowLines(workflows,mode);
  if(!lines.length)return null;
  return <Box flexDirection="column" width={width}>{lines.map((line,index)=><Text key={index} wrap="truncate-end" dimColor={index===lines.length-1}>{line}</Text>)}</Box>;
});

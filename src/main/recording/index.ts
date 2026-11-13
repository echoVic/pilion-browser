// 主进程从录制模块用到的全部名字；模块内部与测试直接从各自的文件导入。
export { MAX_EVENTS, logCapped } from './capture.js';
export {
  RENDER_EVENTS_LIMIT,
  buildDistillPrompt,
  renderEvents,
  stepsHash,
  unsupportedSteps,
  validateSkillEdit,
} from './distill.js';
export { DistillationState } from './distillation.js';
export { describeStep } from './format.js';
export { RecordingLibrary, type RecordingSummary } from './library.js';
export { playSteps, type PlayOutcome } from './player.js';
export { createRecordingSession } from './session.js';
export { StepSchema, type Skill, type Step, type Trajectory } from './types.js';

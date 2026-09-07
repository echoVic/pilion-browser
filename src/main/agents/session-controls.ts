import { z } from 'zod';
import type {
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
  SessionMode,
} from '@agentclientprotocol/sdk';
import type { PermissionMode } from '../../shared/contracts.js';

export const LegacyModelsSchema = z.object({
  currentModelId: z.string(),
  availableModels: z.array(z.object({ modelId: z.string(), name: z.string() })),
});
export type LegacyModels = z.infer<typeof LegacyModelsSchema>;

export function flattenOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  return options.flatMap((option) => ('options' in option ? option.options : [option]));
}
export function modelOption(options: readonly SessionConfigOption[]) {
  return options.find(
    (option) => option.type === 'select' && (option.category === 'model' || option.id === 'model'),
  );
}
export function permissionTarget(
  mode: PermissionMode,
  modes: readonly SessionMode[],
  options: readonly SessionConfigOption[],
) {
  const candidates =
    mode === 'full'
      ? [
          'bypasspermissions',
          'agent-full-access',
          'full-access',
          'unrestricted',
          'yolo',
          'auto',
          'dontask',
          'build',
          'agent',
        ]
      : ['default', 'ask', 'prompt', 'agent', 'build', 'code'];
  const option = options.find(
    (item) =>
      item.type === 'select' &&
      (item.category === 'mode' || ['mode', 'permission_mode', 'approval_mode'].includes(item.id)),
  );
  const choices =
    option?.type === 'select'
      ? flattenOptions(option.options)
      : modes.map((item) => ({ value: item.id, name: item.name }));
  for (const candidate of candidates) {
    const target = choices.find((item) => item.value.toLowerCase() === candidate);
    if (target) return { value: target.value, configId: option?.id };
  }
}

import type { CanonicalCommandV1 } from './canonical.js';
import type { EffectLevel } from './types.js';

export type RiskReason =
  | 'PURE_OBSERVATION'
  | 'VIEWPORT_CHANGE'
  | 'PAGE_STATE_CHANGE'
  | 'PAYMENT_OR_SUBSCRIPTION'
  | 'SEND_PUBLISH_OR_SIGN'
  | 'DELETE_OR_IRREVERSIBLE'
  | 'ACCOUNT_ROLE_OR_PERMISSION'
  | 'OAUTH_AUTHORIZATION'
  | 'SENSITIVE_INPUT'
  | 'FILE_EXFILTRATION'
  | 'EXECUTABLE_DOWNLOAD'
  | 'EXTERNAL_PROTOCOL'
  | 'CROSS_TENANT'
  | 'UNCLASSIFIED'
  | 'CONTEXT_MISSING'
  | 'POLICY_UNAVAILABLE';

export interface SemanticContext {
  operation?: string;
  elementRole?: string;
  accessibleName?: string;
  inputType?: string;
  targetOrigin?: string;
  currentTenantId?: string;
  targetTenantId?: string;
  dataClassifications?: string[];
  destination?: string;
  irreversible?: boolean;
  changesExternalState?: boolean;
  classifierConfident?: boolean;
}

export interface RiskClassification {
  effect: EffectLevel;
  highRisk: boolean;
  certain: boolean;
  reasons: RiskReason[];
}

const highRiskPatterns: Array<[RegExp, RiskReason]> = [
  [/pay|purchase|checkout|subscribe|付款|购买|订阅/i, 'PAYMENT_OR_SUBSCRIPTION'],
  [/send|publish|post|sign|submit|发送|发布|签署|提交/i, 'SEND_PUBLISH_OR_SIGN'],
  [/delete|remove|destroy|删除|永久/i, 'DELETE_OR_IRREVERSIBLE'],
  [/permission|role|account|member|权限|角色|账户/i, 'ACCOUNT_ROLE_OR_PERMISSION'],
  [/oauth|authorize|授权/i, 'OAUTH_AUTHORIZATION'],
];

export function classifySemanticRisk(context: SemanticContext): RiskClassification {
  const reasons: RiskReason[] = [];
  const text = `${context.operation ?? ''} ${context.elementRole ?? ''} ${context.accessibleName ?? ''}`;
  for (const [pattern, reason] of highRiskPatterns) if (pattern.test(text)) reasons.push(reason);
  if (context.irreversible) reasons.push('DELETE_OR_IRREVERSIBLE');
  if (['password', 'hidden'].includes(context.inputType ?? '')) reasons.push('SENSITIVE_INPUT');
  if (context.dataClassifications?.some((x) => /credential|secret|personal|sensitive/i.test(x))) {
    reasons.push('SENSITIVE_INPUT');
  }
  if (context.destination === 'file-upload' || context.operation === 'upload')
    reasons.push('FILE_EXFILTRATION');
  if (context.operation === 'download-executable') reasons.push('EXECUTABLE_DOWNLOAD');
  if (context.targetOrigin && !/^https?:\/\//i.test(context.targetOrigin))
    reasons.push('EXTERNAL_PROTOCOL');
  if (
    context.currentTenantId &&
    context.targetTenantId &&
    context.currentTenantId !== context.targetTenantId
  )
    reasons.push('CROSS_TENANT');

  const knownOperation = Boolean(context.operation && context.targetOrigin);
  const certain = context.classifierConfident !== false && knownOperation;
  if (!certain) reasons.push(context.targetOrigin ? 'UNCLASSIFIED' : 'CONTEXT_MISSING');
  const highRisk =
    Boolean(context.changesExternalState) ||
    reasons.some((reason) => !['UNCLASSIFIED', 'CONTEXT_MISSING'].includes(reason));
  let effect: EffectLevel;
  if (highRisk || context.changesExternalState) effect = 'external-side-effect';
  else if (/observe|read|list|page_info|screenshot/i.test(context.operation ?? ''))
    effect = 'pure-observe';
  else if (/scroll|focus|activate/i.test(context.operation ?? '')) effect = 'viewport-mutating';
  else effect = 'page-mutating';
  if (reasons.length === 0)
    reasons.push(
      effect === 'pure-observe'
        ? 'PURE_OBSERVATION'
        : effect === 'viewport-mutating'
          ? 'VIEWPORT_CHANGE'
          : 'PAGE_STATE_CHANGE',
    );
  return { effect, highRisk, certain, reasons: [...new Set(reasons)] };
}

export type Obligation = {
  type: 'revalidate_target' | 'trusted_approval' | 'https_only';
  parameters: Record<string, unknown>;
};
export interface PolicyVerdict {
  verdict: 'allow' | 'require_approval' | 'deny';
  policySetVersion: string;
  reasonCodes: RiskReason[];
  obligations: Obligation[];
}

export function evaluatePolicy(input: {
  classification?: RiskClassification;
  policySetVersion?: string;
  policyLoaded: boolean;
  trustedApprovalAvailable: boolean;
  contextComplete: boolean;
  command?: CanonicalCommandV1;
}): PolicyVerdict {
  const version = input.policySetVersion ?? 'unavailable';
  if (!input.policyLoaded)
    return {
      verdict: 'deny',
      policySetVersion: version,
      reasonCodes: ['POLICY_UNAVAILABLE'],
      obligations: [],
    };
  if (!input.contextComplete || !input.classification) {
    return input.trustedApprovalAvailable
      ? {
          verdict: 'require_approval',
          policySetVersion: version,
          reasonCodes: ['CONTEXT_MISSING'],
          obligations: [
            { type: 'trusted_approval', parameters: {} },
            { type: 'revalidate_target', parameters: {} },
          ],
        }
      : {
          verdict: 'deny',
          policySetVersion: version,
          reasonCodes: ['CONTEXT_MISSING'],
          obligations: [],
        };
  }
  const risk = input.classification;
  if ((!risk.certain || risk.highRisk) && !input.trustedApprovalAvailable) {
    return {
      verdict: 'deny',
      policySetVersion: version,
      reasonCodes: risk.reasons,
      obligations: [],
    };
  }
  if (!risk.certain || risk.highRisk) {
    return {
      verdict: 'require_approval',
      policySetVersion: version,
      reasonCodes: risk.reasons,
      obligations: [
        { type: 'trusted_approval', parameters: {} },
        { type: 'revalidate_target', parameters: {} },
      ],
    };
  }
  return {
    verdict: 'allow',
    policySetVersion: version,
    reasonCodes: risk.reasons,
    obligations:
      risk.effect === 'pure-observe' ? [] : [{ type: 'revalidate_target', parameters: {} }],
  };
}

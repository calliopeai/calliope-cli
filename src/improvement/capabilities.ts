/** Versioned description of implemented native mechanisms, never a permission grant. */
export function improvementCapabilities() {
  return {
    version: 2,
    kind: 'improvement.capabilities',
    owner: 'calliope-cli',
    mechanisms: {
      recursiveTaskStrategy: true,
      crossRunLearnedStrategy: false,
      modelTraining: false,
      externalFeedbackImport: false,
    },
    historyVersions: [1, 2, 3],
    hostAdmission: {
      version: 1,
      option: 'expectedExecutionRevision',
      operations: ['propose', 'run'],
      semantics: 'exact-revision-before-start',
      controllerReset: 'own-committed-event',
    },
    operations: {
      history: {mode: 'read-only', mayCallModel: false},
      propose: {mode: 'reviewed-mutation', mayCallModel: true},
      run: {mode: 'reviewed-mutation', mayCallModel: true},
      rollback: {mode: 'reviewed-mutation', mayCallModel: false},
    },
    scope: {
      owner: 'native-project-run',
      requiredPlanVersion: 4,
      activation: 'exact-proposal-hash-and-native-policy',
      inheritedLimits: ['scope', 'budget', 'deadline', 'depth', 'count'],
      rollback: 'strategy-withdrawal-no-source-inverse-or-refund',
    },
    evidence: {
      authority: 'native-execution-and-request-journals',
      hypotheses: 'proposed-not-verified-facts',
      acceptance: 'source-attributed-native-checks-or-human-acceptance',
      missingMetrics: 'null-not-zero',
      cost: 'comparable-only-with-settled-bound-request-provenance',
    },
    notice: 'Capabilities describe this CLI implementation. Inspect the exact project/run and current policy before acting. No feedback is imported, no project is opened, and no authority or budget is granted by this query.',
  } as const;
}

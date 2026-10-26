import {buildIdentity} from '../build-identity.js';
import {improvementCapabilities} from './capabilities.js';
import {improvementReviewCapabilities} from './review-requests.js';
import {sourceChangeCapabilities} from './source-changes.js';
import {taskOutcomeCapabilities} from './task-outcomes.js';

/** Discovery only: each native operation retains its own policy and revision checks. */
export function improvementHostCapabilities() {
  return {version:1,kind:'improvement.host-capabilities',owner:'calliope-cli',implementation:buildIdentity(),
    interfaces:{execution:improvementCapabilities(),review:improvementReviewCapabilities(),
      taskOutcome:taskOutcomeCapabilities(),sourceChange:sourceChangeCapabilities()},
    transport:{discovery:'cli-json',operations:'native-library',module:'@calliopelabs/cli/dist/improvement/index.js',cliEnvelopeVersion:1},
    provenance:{trust:'verify-the-installed-artifact',repository:'https://github.com/calliopeai/calliope-cli',
      npm:'verify-registry-integrity-and-publish-workflow-provenance',
      standalone:'verify-release-checksums-and-binary-workflow-attestations',
      source:'match-the-attested-source-commit-and-release-tag'},
    notice:'Describes installed native interfaces, not remote RPC support or execution authority. Unavailable or dirty source metadata cannot establish a released build. Cross-run learning, external feedback import and model training remain unsupported.'} as const;
}

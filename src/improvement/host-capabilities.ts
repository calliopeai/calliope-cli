import {buildIdentity} from '../build-identity.js';
import {improvementCapabilities} from './capabilities.js';
import {improvementReviewCapabilities} from './review-requests.js';
import {sourceChangeCapabilities} from './source-changes.js';
import {taskOutcomeCapabilities} from './task-outcomes.js';
import {taskFeedbackCapabilities} from './task-feedback.js';

/** Discovery only: each native operation retains its own policy and revision checks. */
function legacyHostCapabilities() {
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
function feedbackHostCapabilities(){
  const legacy=legacyHostCapabilities();
  return {...legacy,version:2,interfaces:{...legacy.interfaces,taskFeedback:taskFeedbackCapabilities()},
    notice:'Describes installed native interfaces, not execution authority. Task assessments require native policy review and verified outcome identity; they do not award rewards, train models or enable cross-run learned selection. Verify the installed artifact independently.'} as const;
}
export function improvementHostCapabilities():ReturnType<typeof legacyHostCapabilities>;
export function improvementHostCapabilities(version:1):ReturnType<typeof legacyHostCapabilities>;
export function improvementHostCapabilities(version:2):ReturnType<typeof feedbackHostCapabilities>;
export function improvementHostCapabilities(version:1|2=1){return version===2?feedbackHostCapabilities():legacyHostCapabilities();}

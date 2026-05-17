// Compliance validators were promoted to @presswork/shared so the dashboard's
// edit flow can run the exact same gates the publisher does. Re-exported here
// for back-compat with publisher.ts and the existing test file.
export {
  ComplianceError,
  validateAiDisclosure,
  validateCopyCompliance,
  validateMockupProvenance,
  validateNoForbiddenTerms,
  validateNoOffPlatform,
  validateProductionPartnerId,
} from "@presswork/shared";

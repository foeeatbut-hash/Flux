import { validateClassMappings } from './docflowClassRefs.js';
import { validateKits } from './docflowKitRefs.js';

export async function validateDocflowReferences(prisma: any, raw: unknown) {
  await validateClassMappings(prisma, raw);
  await validateKits(prisma, raw);
}

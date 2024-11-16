import type { JSONSchema } from "./types.js";

const RESOURCE_TYPE_PREFIX = "resource-";

export const extractResourceTypeFromSchema = (schema: JSONSchema) => {
  if (
    schema.type !== "object" ||
    !schema.format?.startsWith(RESOURCE_TYPE_PREFIX)
  ) {
    return false;
  }

  return {
    resourceType: schema.format.slice(RESOURCE_TYPE_PREFIX.length),
  };
};

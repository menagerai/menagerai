import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

// Teach zod the `.openapi()` helper once, before any schema is declared, so the
// same schemas drive both request validation and the generated OpenAPI document.
extendZodWithOpenApi(z);

export { z };

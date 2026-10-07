import base from './vite.phase2b.config.js';

// Test-only composition of the exact reviewed saver. No application handler,
// callable, transaction or authorization implementation is replaced.
export function useReviewedNonMoneySaver(html) {
  const source = 'import { createTenantDataLoader, createStudentDataLoader, createTenantDataSaver } from "./src/phase3/tenantDataService.js";';
  if (html.split(source).length !== 2) throw new Error('Combined saver import must occur exactly once.');
  return html.replace(source,
    'import { createTenantDataLoader, createStudentDataLoader } from "./src/phase3/tenantDataService.js";\n' +
    'import { createNonMoneyTenantDataSaver as createTenantDataSaver } from "./src/phase3/nonMoneyTenantDataSaver.js";');
}
export default { ...base, envDir: false, plugins: [...base.plugins, {
  name: 'reviewed-writer-containment-composition',
  transformIndexHtml: { order: 'pre', handler: useReviewedNonMoneySaver },
}] };

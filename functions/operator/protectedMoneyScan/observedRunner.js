import { copyScanPlan, runProtectedMoneyScan } from './runner.js'
import { createMaintenanceObserver } from './maintenanceObserver.js'
import { abortSummary, DEMO_PROJECT, fail, ScanAbort } from './common.js'

// Fictional composition only. It never accepts a caller-supplied observer or a
// pre-approved fence Boolean. No live collector, credential or transport exists.
export async function runObservedMoneyScan(input, expectation, dependencies) {
  let observer, result
  try {
    const plan = copyScanPlan(input)
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) fail('authorization')
    const { collector, reader, publisher, clock, monotonic } = dependencies
    // Validate the original capability before wrappers can hide missing methods.
    if (reader?.projectId !== DEMO_PROJECT || reader.databaseId !== '(default)' || reader.kind !== 'loopback-read-only' ||
        typeof reader.listPage !== 'function' || typeof reader.get !== 'function') fail('authorization')
    observer = createMaintenanceObserver(plan, expectation, { collector, clock, monotonic })
    const guardedReader = { kind: reader.kind, projectId: reader.projectId, databaseId: reader.databaseId,
      async listPage(...args) { observer.assertCurrent();return reader.listPage(...args) },
      async get(...args) { observer.assertCurrent();return reader.get(...args) },
    }
    result = await runProtectedMoneyScan(plan, { reader: guardedReader, observer, publisher, clock, monotonic })
  } catch (error) { result = abortSummary(error) }
  finally {
    // A timed-out dependency may still be settling. Close admission immediately;
    // retain its cooperative lease until outstanding observer work settles.
    if (observer && !observer.close() && result?.status === 'complete') result = abortSummary(new ScanAbort('continuity'), true)
  }
  return result
}

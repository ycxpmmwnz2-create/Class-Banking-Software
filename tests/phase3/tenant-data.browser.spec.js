// Phase 3 Commit 8 browser evidence.
//
// Playwright's credential-isolated config intentionally discovers only
// tests/browser. tests/browser/tenant-isolation.spec.js imports and registers
// this authorized Phase 3 suite so it runs inside the same real Auth,
// Functions, Firestore, proposed-rules, Vite, and Chromium harness without a
// second emulator command or a production test hook.

import { expect, test } from '@playwright/test'

import { SHARED_LOGIN_ID, TENANT_A, TENANT_B } from '../browser/phase2b-fixtures.js'

export function registerTenantDataBrowserTests({ getSeeded, gotoApp, waitForQuiescence }) {
  async function signInTeacher(page, tenant) {
    await page.evaluate(
      ({ email, password }) => window.__PHASE2B_TEST__.signInTeacher(email, password),
      { email: tenant.email, password: tenant.password },
    )
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(tenant.studentMarker)
  }

  async function logout(page) {
    await page.evaluate(() => window.logout())
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()
  }

  async function activateThroughProductionUi(page, tenant, pin) {
    await signInTeacher(page, tenant)
    await page.evaluate(studentId => window.viewStudentProfile(Number(studentId)), tenant.sharedStudentId)
    await expect(page.locator('#profileNewStudentPin')).toBeVisible()
    await page.locator('#profileNewStudentPin').fill(pin)
    await page.evaluate(() => window.resetProfileStudentPin())
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'PIN reset successfully for Shared Name.',
    )
    await logout(page)
  }

  async function submitStudentLogin(page, { classroomCode, loginId, pin }) {
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#studentClassroomCode')).toBeVisible()
    await page.locator('#studentClassroomCode').fill(classroomCode)
    await page.locator('#studentLoginId').fill(loginId)
    await page.locator('#studentPin').fill(pin)
    await page.evaluate(() => window.loginStudent())
  }

  test('Phase 3 student UI uses classroom-qualified V2 login, real custom-token claims, and the exact self document', async ({ page }) => {
    const seeded = getSeeded()
    await gotoApp(page)

    // Activate each same-login-ID credential through the production teacher UI
    // and resetStudentPinV2. Distinct PINs make both cross-classroom directions
    // observable rather than relying on an absent or inactive credential.
    await activateThroughProductionUi(page, TENANT_A, '2468')
    await activateThroughProductionUi(page, TENANT_B, '8642')

    // Same login ID, wrong classroom/PIN pairing: both directions stay generic
    // and signed out. A legacy login call would consult the flat fixture instead
    // and cannot pass this matrix.
    await submitStudentLogin(page, {
      classroomCode: TENANT_B.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Wrong classroom code, student login ID, or PIN.',
    )
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()

    await submitStudentLogin(page, {
      classroomCode: TENANT_A.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '8642',
    })
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Wrong classroom code, student login ID, or PIN.',
    )
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()

    const beforeA = await page.evaluate(() => window.__PHASE2B_TEST__.events().length)
    await submitStudentLogin(page, {
      classroomCode: TENANT_A.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.credentials.aSharedCredential.authUid,
    )
    await waitForQuiescence(page)
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain('Shared Name')

    const studentAPaths = await page.evaluate(
      from => window.__PHASE2B_TEST__.events()
        .slice(from)
        .filter(event => event.type === 'loadAdapter:start')
        .map(event => event.detail?.path),
      beforeA,
    )
    expect(studentAPaths).toEqual([
      `classrooms/${TENANT_A.classroomId}/students/${TENANT_A.sharedStudentId}`,
    ])

    const localState = await page.evaluate(() => ({
      keys: Object.keys(localStorage),
      values: Object.keys(localStorage).map(key => localStorage.getItem(key)),
      body: document.body.innerText,
      pinPresent: Boolean(document.getElementById('studentPin')),
    }))
    expect(localState.keys.filter(key => key.endsWith(':data:v1'))).toEqual([])
    expect(localState.keys).not.toContain('mrMorganClassCashDataV5')
    expect(localState.values.join('\n')).not.toContain('2468')
    expect(localState.values.join('\n')).not.toContain('8642')
    expect(localState.body).not.toContain('2468')
    expect(localState.body).not.toContain('8642')
    expect(localState.pinPresent).toBe(false)

    await logout(page)
    const beforeB = await page.evaluate(() => window.__PHASE2B_TEST__.events().length)
    await submitStudentLogin(page, {
      classroomCode: TENANT_B.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '8642',
    })
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.credentials.bSharedCredential.authUid,
    )
    await waitForQuiescence(page)
    const studentBPaths = await page.evaluate(
      from => window.__PHASE2B_TEST__.events()
        .slice(from)
        .filter(event => event.type === 'loadAdapter:start')
        .map(event => event.detail?.path),
      beforeB,
    )
    expect(studentBPaths).toEqual([
      `classrooms/${TENANT_B.classroomId}/students/${TENANT_B.sharedStudentId}`,
    ])
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(TENANT_A.studentMarker)
  })

  test('Phase 3 V2 destructive controls are absent and direct invocation is inert', async ({ page }) => {
    await gotoApp(page)
    await signInTeacher(page, TENANT_A)
    await waitForQuiescence(page)
    await page.evaluate(() => window.setScreen('settings'))

    await expect(page.getByRole('button', { name: 'Clear Transaction History' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Reset Everything', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Clear All Login History' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset All Balances to $0' })).toBeVisible()
    await expect(page.getByText(/separately reviewed server workflow/)).toBeVisible()

    const before = await page.evaluate(() => ({
      uid: window.__PHASE2B_TEST__.currentUid(),
      eventCount: window.__PHASE2B_TEST__.events().length,
      body: document.body.innerText,
    }))

    await page.evaluate(() => window.clearTransactions())
    await expect(page.getByText('Clearing transaction history is unavailable in this version.'))
      .toBeVisible()
    await waitForQuiescence(page)

    await page.evaluate(() => window.resetEverything())
    await expect(page.getByText('Reset Everything is unavailable in this version.')).toBeVisible()
    await waitForQuiescence(page)

    const after = await page.evaluate(() => ({
      uid: window.__PHASE2B_TEST__.currentUid(),
      eventCount: window.__PHASE2B_TEST__.events().length,
      body: document.body.innerText,
    }))
    expect(after.uid).toBe(before.uid)
    expect(after.eventCount).toBe(before.eventCount)
    expect(after.body).toContain(TENANT_A.studentMarker)
    expect(before.body).toContain(TENANT_A.studentMarker)
  })
}

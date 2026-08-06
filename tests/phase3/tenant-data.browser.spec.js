// Phase 3 Commit 8 browser evidence.
//
// Playwright's credential-isolated config intentionally discovers only
// tests/browser. tests/browser/tenant-isolation.spec.js imports and registers
// this authorized Phase 3 suite so it runs inside the same real Auth,
// Functions, Firestore, Vite, and Chromium harness without a second emulator
// command or a production test hook. The invoking command selects either the
// historical proposed rules or the checksum-pinned Phase 3 final candidate.

import { expect, test } from '@playwright/test'

import { PROJECT_ID, SHARED_LOGIN_ID, TENANT_A, TENANT_B } from '../browser/phase2b-fixtures.js'

const CLASSROOM_CODE_STORAGE_KEY =
  `morganBank:v2:${PROJECT_ID}:student-login:classroom-code:v1`

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
    // viewStudentProfile renders the input synchronously, then awaits its
    // auxiliary login-ID read. Enter the PIN in that same task so the read is
    // guaranteed to complete after typing; its targeted status update must not
    // replace the input or discard the value.
    await page.evaluate(({ studentId, enteredPin }) => {
      window.__PHASE3_PROFILE_STATUS_PROMISE__ = window.viewStudentProfile(Number(studentId))
      const input = document.getElementById('profileNewStudentPin')
      if (!input) throw new Error('profile PIN input did not render synchronously')
      input.value = enteredPin
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, { studentId: tenant.sharedStudentId, enteredPin: pin })
    await page.evaluate(() => window.__PHASE3_PROFILE_STATUS_PROMISE__)
    await expect(page.locator('#profileLoginIdStatus')).toHaveText(SHARED_LOGIN_ID)
    await expect(page.locator('#profileNewStudentPin')).toHaveValue(pin)
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

  test('teacher can reveal, copy, and temporarily display only the newly submitted PIN', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          async writeText(text) {
            window.__COPIED_PROFILE_PIN__ = String(text)
          },
        },
      })
    })

    await gotoApp(page)
    await signInTeacher(page, TENANT_A)
    await page.evaluate(studentId => window.viewStudentProfile(Number(studentId)), TENANT_A.sharedStudentId)
    await expect(page.locator('#profileLoginIdStatus')).toHaveText(SHARED_LOGIN_ID)

    const pinInput = page.locator('#profileNewStudentPin')
    const visibilityButton = page.locator('#profileNewStudentPinVisibilityButton')
    await pinInput.fill('1357')
    await expect(pinInput).toHaveAttribute('type', 'password')
    await visibilityButton.click()
    await expect(pinInput).toHaveAttribute('type', 'text')
    await expect(visibilityButton).toHaveText('Hide PIN')
    await visibilityButton.click()
    await expect(pinInput).toHaveAttribute('type', 'password')

    await page.getByRole('button', { name: 'Copy typed PIN' }).click()
    await expect(page.locator('#profileNewStudentPinCopyStatus')).toHaveText('New PIN copied.')
    expect(await page.evaluate(() => window.__COPIED_PROFILE_PIN__)).toBe('1357')

    await page.evaluate(() => window.resetProfileStudentPin())
    await expect(page.locator('#temporaryProfileStudentPin')).toBeVisible()
    await expect(page.locator('#temporaryProfileStudentPinValue')).toHaveText('1357')
    await expect(page.locator('#profileNewStudentPin')).toHaveValue('')

    const storageValues = await page.evaluate(() => [
      ...Object.keys(localStorage).map(key => localStorage.getItem(key)),
      ...Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)),
    ])
    expect(storageValues.join('\n')).not.toContain('1357')

    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => { throw new DOMException('Denied', 'NotAllowedError') } },
      })
      document.execCommand = () => false
    })
    await page.getByRole('button', { name: 'Copy PIN for student' }).click()
    await expect(page.locator('#temporaryProfileStudentPinCopyStatus')).toHaveText(
      'Could not copy the new PIN. Select it and copy it manually.',
    )
    expect(await page.locator('textarea').count()).toBe(0)

    await pinInput.fill('12')
    await page.evaluate(() => window.resetProfileStudentPin())
    await expect(page.locator('#temporaryProfileStudentPin')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Enter a new PIN containing exactly 4 digits.',
    )

    await pinInput.fill('1357')
    await page.evaluate(() => window.resetProfileStudentPin())
    await expect(page.locator('#temporaryProfileStudentPinValue')).toHaveText('1357')
    await page.getByRole('button', { name: 'Done — hide PIN' }).click()
    await expect(page.locator('#temporaryProfileStudentPin')).toHaveCount(0)

    await pinInput.fill('1357')
    await page.evaluate(() => window.resetProfileStudentPin())
    await expect(page.locator('#temporaryProfileStudentPinValue')).toHaveText('1357')
    await page.locator('#profileStudentSelect').selectOption(TENANT_A.studentId)
    await expect(page.locator('#temporaryProfileStudentPin')).toHaveCount(0)
    await page.locator('#profileStudentSelect').selectOption(TENANT_A.sharedStudentId)
    await expect(page.locator('#temporaryProfileStudentPin')).toHaveCount(0)

    await pinInput.fill('1357')
    await page.evaluate(() => window.resetProfileStudentPin())
    await expect(page.locator('#temporaryProfileStudentPinValue')).toHaveText('1357')
    await page.reload()
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(TENANT_A.studentMarker)
    await expect(page.getByText('1357', { exact: true })).toHaveCount(0)
    expect((await page.evaluate(() => [
      ...Object.keys(localStorage).map(key => localStorage.getItem(key)),
      ...Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)),
    ])).join('\n')).not.toContain('1357')
  })

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
    expect(
      await page.evaluate(() => window.__PHASE2B_TEST__.localKeys()
        .filter(key => key.endsWith(':student-login:classroom-code:v1'))),
    ).toEqual([])

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
    expect(localState.keys.filter(key => key.endsWith(':student-login:classroom-code:v1'))).toEqual([
      CLASSROOM_CODE_STORAGE_KEY,
    ])
    expect(localState.values).toContain(TENANT_A.studentLoginCode)
    expect(localState.values.join('\n')).not.toContain('2468')
    expect(localState.values.join('\n')).not.toContain('8642')
    expect(localState.values.join('\n')).not.toContain(SHARED_LOGIN_ID)
    expect(localState.keys.join('\n')).not.toContain(SHARED_LOGIN_ID)
    expect(localState.body).not.toContain('2468')
    expect(localState.body).not.toContain('8642')
    expect(localState.pinPresent).toBe(false)

    await logout(page)
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#studentClassroomCode')).toHaveValue(TENANT_A.studentLoginCode)
    await expect(page.locator('#studentLoginId')).toHaveValue('')
    await expect(page.locator('#studentPin')).toHaveValue('')

    await submitStudentLogin(page, {
      classroomCode: TENANT_B.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Wrong classroom code, student login ID, or PIN.',
    )
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()
    expect(
      await page.evaluate(
        key => window.__PHASE2B_TEST__.localGet(key),
        CLASSROOM_CODE_STORAGE_KEY,
      ),
    ).toBe(TENANT_A.studentLoginCode)

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
    expect(
      await page.evaluate(
        key => window.__PHASE2B_TEST__.localGet(key),
        CLASSROOM_CODE_STORAGE_KEY,
      ),
    ).toBe(TENANT_B.studentLoginCode)
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(TENANT_A.studentMarker)
  })

  test('student login succeeds when remembering the classroom code is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem
      Object.defineProperty(Storage.prototype, 'setItem', {
        configurable: true,
        value(key, value) {
          if (String(key).endsWith(':student-login:classroom-code:v1')) {
            window.__CLASSROOM_CODE_STORAGE_ATTEMPTS__ =
              (window.__CLASSROOM_CODE_STORAGE_ATTEMPTS__ || 0) + 1
            throw new DOMException('Storage unavailable', 'QuotaExceededError')
          }
          return originalSetItem.call(this, key, value)
        },
      })
    })

    const seeded = getSeeded()
    await gotoApp(page)
    await activateThroughProductionUi(page, TENANT_A, '2468')
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
    expect(await page.evaluate(() => window.__CLASSROOM_CODE_STORAGE_ATTEMPTS__)).toBe(1)
    expect(
      await page.evaluate(
        key => window.__PHASE2B_TEST__.localGet(key),
        CLASSROOM_CODE_STORAGE_KEY,
      ),
    ).toBeNull()
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
      rosterOptions: Array.from(
        document.querySelectorAll('#loginHistoryStudentSelect option'),
        option => option.textContent?.trim(),
      ),
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
      rosterOptions: Array.from(
        document.querySelectorAll('#loginHistoryStudentSelect option'),
        option => option.textContent?.trim(),
      ),
    }))
    expect(after.uid).toBe(before.uid)
    expect(after.eventCount).toBe(before.eventCount)
    expect(before.rosterOptions).toContain(TENANT_A.studentMarker)
    expect(after.rosterOptions).toEqual(before.rosterOptions)
  })

  test('Phase 3 supported student removal survives reload and a later scoped save', async ({ page }) => {
    const seeded = getSeeded()
    await gotoApp(page)
    await signInTeacher(page, TENANT_A)
    await waitForQuiescence(page)

    page.once('dialog', dialog => dialog.accept())
    await page.evaluate(studentId => window.removeStudent(Number(studentId)), TENANT_A.studentId)
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      `${TENANT_A.studentMarker} removed.`,
    )

    // Reload through the production Auth observer and tenant-data loader. The
    // removed roster document is gone, while its transaction and login-history
    // records intentionally remain under the same classroom.
    await gotoApp(page)
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.aUid,
    )
    await waitForQuiescence(page)

    await page.evaluate(() => window.setScreen('roster'))
    await expect(page.locator(`#name-${TENANT_A.studentId}`)).toHaveCount(0)
    await expect(page.locator(`#name-${TENANT_A.sharedStudentId}`)).toBeVisible()

    await page.evaluate(() => window.setScreen('teacher'))
    await expect(page.getByRole('cell', { name: TENANT_A.transactionMarker, exact: true })).toBeVisible()

    // A successful later UI save proves decomposition also accepts the
    // historical off-roster records; merely rendering after reload would not.
    const savesBefore = await page.evaluate(
      () => window.__PHASE2B_TEST__.eventTypes().filter(type => type === 'saveAdapter:done').length,
    )
    await page.evaluate(() => {
      window.setScreen('editSettingsLists')
      const input = document.getElementById('purchaseCategoryList')
      if (!input) throw new Error('settings list input did not render')
      input.value = 'POST_REMOVAL_SAVE'
      window.saveSettingsLists()
    })
    await expect.poll(() => page.evaluate(
      () => window.__PHASE2B_TEST__.eventTypes().filter(type => type === 'saveAdapter:done').length,
    )).toBeGreaterThan(savesBefore)
    await waitForQuiescence(page)
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.lastError())).toBeNull()
  })
}

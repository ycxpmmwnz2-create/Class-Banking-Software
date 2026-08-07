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
// The combined locator that supersedes the classroom-code-only key. Andrew
// approved remembering the non-secret classroom code and canonical login ID so a
// returning student types only a PIN; the PIN, token, and every student record
// stay unstored.
const LOGIN_LOCATOR_STORAGE_KEY =
  `morganBank:v2:${PROJECT_ID}:student-login:locator:v1`

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

  // A browser that already remembers a student renders the PIN-only form, so the
  // full form is reached through the same student-operable switch control rather
  // than by clearing storage behind the UI's back.
  async function submitStudentLogin(page, { classroomCode, loginId, pin }) {
    await page.evaluate(() => window.setLoginTab('student'))
    if (await page.locator('#useDifferentStudent').count()) {
      await page.locator('#useDifferentStudent').click()
    }
    await expect(page.locator('#studentClassroomCode')).toBeVisible()
    await page.locator('#studentClassroomCode').fill(classroomCode)
    await page.locator('#studentLoginId').fill(loginId)
    await page.locator('#studentPin').fill(pin)
    await page.evaluate(() => window.loginStudent())
  }

  // The returning-student path: the PIN is the only value typed, and the classroom
  // code and login ID must come from the remembered locator.
  async function submitRememberedStudentPin(page, pin) {
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#studentPin')).toBeVisible()
    await expect(page.locator('#studentClassroomCode')).toHaveCount(0)
    await expect(page.locator('#studentLoginId')).toHaveCount(0)
    await page.locator('#studentPin').fill(pin)
    await page.evaluate(() => window.loginStudent())
  }

  function readLocator(page) {
    return page.evaluate(
      key => window.__PHASE2B_TEST__.localGet(key),
      LOGIN_LOCATOR_STORAGE_KEY,
    )
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
    await pinInput.fill('9753')
    await page.getByRole('button', { name: 'Done — hide PIN' }).click()
    await expect(page.locator('#temporaryProfileStudentPin')).toHaveCount(0)
    await expect(pinInput).toHaveValue('9753')

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
    const finalStorageValues = (await page.evaluate(() => [
      ...Object.keys(localStorage).map(key => localStorage.getItem(key)),
      ...Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)),
    ])).join('\n')
    expect(finalStorageValues).not.toContain('1357')
    expect(finalStorageValues).not.toContain('9753')
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
    // A refused login stores no locator at all — not the classroom code, and not
    // the login ID it was asked to remember.
    expect(
      await page.evaluate(() => window.__PHASE2B_TEST__.localKeys()
        .filter(key => key.includes(':student-login:'))),
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
      // The server contract accepts ASCII uppercase and resolves the canonical
      // lowercase credential. The remembered record must store that canonical
      // identity rather than silently giving up after a successful login.
      loginId: SHARED_LOGIN_ID.toUpperCase(),
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.credentials.aSharedCredential.authUid,
    )
    await waitForQuiescence(page)
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain('Shared Name')

    // At the desktop width where the two money cards sit side by side, the
    // shorter subtract explanation must reserve the same row height as the add
    // explanation so both forms begin on the same horizontal line.
    await page.setViewportSize({ width: 1440, height: 1000 })
    const moneyFormReasonTops = await page.evaluate(() => [
      document.querySelector('label[for="studentAddReason"]')?.getBoundingClientRect().top,
      document.querySelector('label[for="studentSubtractReason"]')?.getBoundingClientRect().top,
    ])
    expect(moneyFormReasonTops.every(Number.isFinite)).toBe(true)
    expect(Math.abs(moneyFormReasonTops[0] - moneyFormReasonTops[1])).toBeLessThanOrEqual(1)

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
    // Exactly one login-preference key: the combined locator. The superseded
    // classroom-code-only key is never written again.
    expect(localState.keys.filter(key => key.includes(':student-login:'))).toEqual([
      LOGIN_LOCATOR_STORAGE_KEY,
    ])
    // The exact canonical record, proving the stored shape rather than merely that
    // the code appears somewhere in storage.
    expect(await readLocator(page)).toBe(
      JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: SHARED_LOGIN_ID }),
    )
    // The login ID is now deliberately persisted, but only inside that locator
    // value. No PIN, and no key is named after a student.
    expect(
      localState.values.filter(value => String(value).includes(SHARED_LOGIN_ID)),
    ).toHaveLength(1)
    expect(localState.values.join('\n')).not.toContain('2468')
    expect(localState.values.join('\n')).not.toContain('8642')
    expect(localState.keys.join('\n')).not.toContain(SHARED_LOGIN_ID)
    expect(localState.body).not.toContain('2468')
    expect(localState.body).not.toContain('8642')
    expect(localState.pinPresent).toBe(false)
    // Remembering the locator must not retain an Auth token or student record.
    const authStorage = await page.evaluate(() => [
      ...Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map(key => `${key}=${sessionStorage.getItem(key)}`),
    ])
    expect(authStorage.filter(entry => entry.startsWith(LOGIN_LOCATOR_STORAGE_KEY)).join('\n'))
      .not.toContain('Shared Name')

    // ---- returning login: the remembered locator yields a PIN-only form ----
    await logout(page)
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#rememberedStudentIdentity')).toContainText(SHARED_LOGIN_ID)
    await expect(page.locator('#rememberedStudentClassroomCode')).toHaveText(
      TENANT_A.studentLoginCode,
    )
    await expect(page.locator('#studentClassroomCode')).toHaveCount(0)
    await expect(page.locator('#studentLoginId')).toHaveCount(0)
    await expect(page.locator('#studentPin')).toHaveValue('')
    // Session-only student Auth: logout must leave no signed-in student behind.
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()

    // A wrong PIN in PIN-only mode stays generic and must not disturb the locator.
    await submitRememberedStudentPin(page, '1111')
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Wrong classroom code, student login ID, or PIN.',
    )
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()
    expect(await readLocator(page)).toBe(
      JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: SHARED_LOGIN_ID }),
    )

    // The PIN alone completes a real second login through the unchanged callable.
    const beforeReturning = await page.evaluate(() => window.__PHASE2B_TEST__.events().length)
    await submitRememberedStudentPin(page, '2468')
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.credentials.aSharedCredential.authUid,
    )
    await waitForQuiescence(page)
    expect(
      await page.evaluate(
        from => window.__PHASE2B_TEST__.events()
          .slice(from)
          .filter(event => event.type === 'loadAdapter:start')
          .map(event => event.detail?.path),
        beforeReturning,
      ),
    ).toEqual([`classrooms/${TENANT_A.classroomId}/students/${TENANT_A.sharedStudentId}`])
    expect(await readLocator(page)).toBe(
      JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: SHARED_LOGIN_ID }),
    )

    // ---- switching students clears only the locator and restores the full form ----
    await logout(page)
    await page.evaluate(() => window.setLoginTab('student'))
    const eventsBeforeSwitch = await page.evaluate(() => window.__PHASE2B_TEST__.events().length)
    await page.locator('#useDifferentStudent').click()
    expect(await readLocator(page)).toBeNull()
    await expect(page.locator('#rememberedStudentIdentity')).toHaveCount(0)
    await expect(page.locator('#studentLoginId')).toHaveValue('')
    await expect(page.locator('#studentPin')).toHaveValue('')
    // No Firebase call and no sign-in side effect: the switch is local and synchronous.
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.events().length)).toBe(
      eventsBeforeSwitch,
    )
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.lastError())).toBeNull()

    await submitStudentLogin(page, {
      classroomCode: TENANT_B.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Wrong classroom code, student login ID, or PIN.',
    )
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBeNull()
    // A refused cross-tenant attempt stores nothing, so the switch remains the only
    // thing that changed the remembered state.
    expect(await readLocator(page)).toBeNull()

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
    expect(await readLocator(page)).toBe(
      JSON.stringify({ classroomCode: TENANT_B.studentLoginCode, loginId: SHARED_LOGIN_ID }),
    )
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(TENANT_A.studentMarker)
  })

  test('student login succeeds when remembering the login locator is unavailable', async ({ page }) => {
    await page.addInitScript(() => {
      const originalSetItem = Storage.prototype.setItem
      Object.defineProperty(Storage.prototype, 'setItem', {
        configurable: true,
        value(key, value) {
          if (String(key).endsWith(':student-login:locator:v1')) {
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
    expect(await readLocator(page)).toBeNull()

    // A failed write must not be papered over with a partial record, and the next
    // visit simply asks for the full form again rather than a PIN-only form built
    // from a locator that was never stored.
    expect(
      await page.evaluate(() => window.__PHASE2B_TEST__.localKeys()
        .filter(key => key.includes(':student-login:'))),
    ).toEqual([])
    await logout(page)
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#studentClassroomCode')).toBeVisible()
    await expect(page.locator('#studentLoginId')).toBeVisible()
    await expect(page.locator('#rememberedStudentIdentity')).toHaveCount(0)
  })

  test('a malformed, foreign-project, or unreadable locator fails safe to the full form', async ({ page }) => {
    const seeded = getSeeded()
    await gotoApp(page)
    await activateThroughProductionUi(page, TENANT_A, '2468')

    // Every one of these must be refused rather than repaired, because a repaired
    // record would let the browser assemble a login identity the server never
    // issued. A foreign-project key must be ignored outright.
    const rejectedRecords = [
      ['not JSON at all', 'x'],
      ['an array', JSON.stringify([TENANT_A.studentLoginCode, SHARED_LOGIN_ID])],
      ['a bare string', JSON.stringify(TENANT_A.studentLoginCode)],
      ['null', JSON.stringify(null)],
      ['a missing login ID', JSON.stringify({ classroomCode: TENANT_A.studentLoginCode })],
      [
        'an extra field smuggling a PIN',
        JSON.stringify({
          classroomCode: TENANT_A.studentLoginCode,
          loginId: SHARED_LOGIN_ID,
          pin: '2468',
        }),
      ],
      [
        'a padded classroom code',
        JSON.stringify({ classroomCode: ` ${TENANT_A.studentLoginCode} `, loginId: SHARED_LOGIN_ID }),
      ],
      [
        'an unformatted classroom code',
        JSON.stringify({
          classroomCode: TENANT_A.studentLoginCode.replace('-', ''),
          loginId: SHARED_LOGIN_ID,
        }),
      ],
      [
        'a noncanonical login ID',
        JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: 'Shared-Name' }),
      ],
      [
        'a login ID with repeated hyphens',
        JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: 'shared--name' }),
      ],
      [
        'a non-string login ID',
        JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: 7 }),
      ],
      [
        'a blank login ID',
        JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: '' }),
      ],
      // Both canonicalizers return "" for a value they reject, so an already-blank
      // record must not be able to compare equal to its own rejection.
      ['blank fields', JSON.stringify({ classroomCode: '', loginId: '' })],
      [
        'a blank classroom code',
        JSON.stringify({ classroomCode: '', loginId: SHARED_LOGIN_ID }),
      ],
    ]

    for (const [label, record] of rejectedRecords) {
      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        { key: LOGIN_LOCATOR_STORAGE_KEY, value: record },
      )
      await gotoApp(page)
      await page.evaluate(() => window.setLoginTab('student'))
      await expect(page.locator('#studentClassroomCode'), label).toBeVisible()
      await expect(page.locator('#studentLoginId'), label).toBeVisible()
      await expect(page.locator('#rememberedStudentIdentity'), label).toHaveCount(0)
      // The corrupt record is dropped rather than re-read forever.
      expect(await readLocator(page), label).toBeNull()
    }

    // A locator belonging to another Firebase project is not this project's key and
    // must never be consumed.
    await page.evaluate(
      value => localStorage.setItem(
        'morganBank:v2:some-other-project:student-login:locator:v1',
        value,
      ),
      JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: SHARED_LOGIN_ID }),
    )
    await gotoApp(page)
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#rememberedStudentIdentity')).toHaveCount(0)
    await expect(page.locator('#studentClassroomCode')).toBeVisible()
    expect(await readLocator(page)).toBeNull()

    // Failing safe must still leave a working login through the real callable.
    await submitStudentLogin(page, {
      classroomCode: TENANT_A.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.credentials.aSharedCredential.authUid,
    )
  })

  test('a legacy classroom-code-only preference still prefills and upgrades only after success', async ({ page }) => {
    const seeded = getSeeded()
    await gotoApp(page)
    await activateThroughProductionUi(page, TENANT_A, '2468')

    // The state a browser is left in by the previous release.
    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: CLASSROOM_CODE_STORAGE_KEY, value: TENANT_A.studentLoginCode },
    )
    await gotoApp(page)
    await page.evaluate(() => window.setLoginTab('student'))

    // One-field convenience only: the code is prefilled, the login ID and PIN are
    // still required, and no PIN-only form appears.
    await expect(page.locator('#rememberedStudentIdentity')).toHaveCount(0)
    await expect(page.locator('#studentClassroomCode')).toHaveValue(TENANT_A.studentLoginCode)
    await expect(page.locator('#studentLoginId')).toHaveValue('')

    // A refused login must not upgrade the legacy key.
    await page.locator('#studentPin').fill('1111')
    await page.locator('#studentLoginId').fill(SHARED_LOGIN_ID)
    await page.evaluate(() => window.loginStudent())
    await expect.poll(() => page.evaluate(() => document.body.innerText)).toContain(
      'Wrong classroom code, student login ID, or PIN.',
    )
    expect(await readLocator(page)).toBeNull()
    expect(
      await page.evaluate(
        key => window.__PHASE2B_TEST__.localGet(key),
        CLASSROOM_CODE_STORAGE_KEY,
      ),
    ).toBe(TENANT_A.studentLoginCode)

    await submitStudentLogin(page, {
      classroomCode: TENANT_A.studentLoginCode,
      loginId: SHARED_LOGIN_ID,
      pin: '2468',
    })
    await expect.poll(() => page.evaluate(() => window.__PHASE2B_TEST__.currentUid())).toBe(
      seeded.credentials.aSharedCredential.authUid,
    )
    await waitForQuiescence(page)

    // The upgrade is atomic: the locator exists and the superseded key is gone.
    expect(await readLocator(page)).toBe(
      JSON.stringify({ classroomCode: TENANT_A.studentLoginCode, loginId: SHARED_LOGIN_ID }),
    )
    expect(
      await page.evaluate(
        key => window.__PHASE2B_TEST__.localGet(key),
        CLASSROOM_CODE_STORAGE_KEY,
      ),
    ).toBeNull()
    expect(
      await page.evaluate(() => window.__PHASE2B_TEST__.localKeys()
        .filter(key => key.includes(':student-login:'))),
    ).toEqual([LOGIN_LOCATOR_STORAGE_KEY])

    // And the browser is now on the fast path.
    await logout(page)
    await page.evaluate(() => window.setLoginTab('student'))
    await expect(page.locator('#rememberedStudentIdentity')).toContainText(SHARED_LOGIN_ID)
  })

  test('Credentials shows a current PIN that never reaches the roster, browser storage, cache, or another tenant', async ({ page }) => {
    await gotoApp(page)

    // Open Credentials and wait for its on-demand directory read. Earlier cases
    // may already have assigned this student a PIN, so this test establishes its
    // own unique value instead of depending on suite order.
    await signInTeacher(page, TENANT_A)
    await waitForQuiescence(page)
    await page.evaluate(() => window.setScreen('roster'))
    await expect(page.locator(`#rosterPin-${TENANT_A.sharedStudentId}`)).toHaveCount(0)
    await page.evaluate(() => window.setScreen('credentials'))
    const credentialRow = page.locator(
      `[data-credential-student-id="${TENANT_A.sharedStudentId}"]`,
    )
    const pinCell = page.locator(`#credentialPinCell-${TENANT_A.sharedStudentId}`)
    await expect(pinCell).not.toContainText('Loading...')
    await expect(pinCell).not.toContainText('Unavailable')

    // One real reset through the production Credentials UI and callable makes
    // the value visible immediately; no reload or second fetch is required.
    page.once('dialog', dialog => dialog.accept('8642'))
    await credentialRow.getByRole('button', { name: /Reset PIN|Activate \/ Set PIN/ }).click()
    await expect(page.locator(`#credentialPin-${TENANT_A.sharedStudentId}`)).toHaveText('8642')
    await expect(credentialRow.getByText('Active', { exact: true })).toBeVisible()

    // Moving the display means the roster has no PIN value even after the
    // directory contains one.
    await page.evaluate(() => window.setScreen('roster'))
    await expect(page.locator(`#rosterPin-${TENANT_A.sharedStudentId}`)).toHaveCount(0)
    await expect(page.locator(`#credentialPin-${TENANT_A.sharedStudentId}`)).toHaveCount(0)
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('8642')

    // The server-backed value is still present after a fresh teacher session.
    await logout(page)
    await signInTeacher(page, TENANT_A)
    await waitForQuiescence(page)
    await page.evaluate(() => window.setScreen('credentials'))
    await expect(page.locator(`#credentialPin-${TENANT_A.sharedStudentId}`)).toHaveText('8642')
    await expect(credentialRow.getByText('Active', { exact: true })).toBeVisible()

    // The displayed PIN must live only in the page. Every persisted surface stays
    // PIN-free, which is what lets the tenant cache and backups remain safe.
    const persisted = await page.evaluate(() => [
      ...Object.keys(localStorage).map(key => `${key}=${localStorage.getItem(key)}`),
      ...Object.keys(sessionStorage).map(key => `${key}=${sessionStorage.getItem(key)}`),
    ])
    expect(persisted.join('\n')).not.toContain('8642')

    // The decisive check that the PIN never entered the aggregate: perform a real
    // save while the PINs are loaded, then inspect the tenant cache envelope the
    // save writes to localStorage. If the PIN had been merged into `data`, it
    // would be serialized into that envelope here.
    const savesBefore = await page.evaluate(
      () => window.__PHASE2B_TEST__.eventTypes().filter(type => type === 'saveAdapter:done').length,
    )
    await page.evaluate(() => {
      window.setScreen('editSettingsLists')
      const input = document.getElementById('purchaseCategoryList')
      if (!input) throw new Error('settings list input did not render')
      input.value = 'PIN_DIRECTORY_SAVE'
      window.saveSettingsLists()
    })
    await expect.poll(() => page.evaluate(
      () => window.__PHASE2B_TEST__.eventTypes().filter(type => type === 'saveAdapter:done').length,
    )).toBeGreaterThan(savesBefore)
    await waitForQuiescence(page)

    const cached = await page.evaluate(() => window.__PHASE2B_TEST__.localKeys()
      .filter(key => key.endsWith(':data:v1'))
      .map(key => window.__PHASE2B_TEST__.localGet(key))
      .join('\n'))
    expect(cached).not.toContain('8642')
    expect(cached).toContain('PIN_DIRECTORY_SAVE')
    expect(await page.evaluate(() => window.__PHASE2B_TEST__.lastError())).toBeNull()

    // Switching tenants must not carry the PIN across, even for one render.
    await logout(page)
    await signInTeacher(page, TENANT_B)
    await waitForQuiescence(page)
    await page.evaluate(() => window.setScreen('credentials'))
    await expect(page.locator(`#credentialPinCell-${TENANT_B.sharedStudentId}`)).toBeVisible()
    await expect(page.locator(`#rosterPin-${TENANT_A.sharedStudentId}`)).toHaveCount(0)
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('8642')
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

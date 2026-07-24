import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

import { provisionTeacherClassroom } from './teacherClassroomProvisioner.js'

const TEACHER_UID = 'YkYUzIzy0aW7roolM1VaLcIJPuN2'

function requireAuthorizedTeacher(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Teacher authentication required.')
  }

  if (auth.uid !== TEACHER_UID) {
    throw new HttpsError('permission-denied', 'Teacher access required.')
  }
}

/**
 * Callable wrapper around the additive Phase 1 provisioner. Restricted to the
 * single existing authorized teacher for now; broader teacher onboarding is
 * out of scope until a later phase.
 */
export async function ensureTeacherClassroomForCaller(
  request,
  options = {},
) {
  requireAuthorizedTeacher(request.auth)

  const firestore = options.firestore ?? getFirestore()
  const provision = options.provisionTeacherClassroom ?? provisionTeacherClassroom

  const { name, email } = request.auth.token ?? {}

  return provision({
    firestore,
    uid: request.auth.uid,
    displayName: name ?? '',
    email: email ?? '',
    // Temporary single-teacher bootstrap value; onboarding will supply this
    // dynamically once multi-teacher creation is introduced in Phase 5.
    classroomName: "Mr. Morgan's Classroom",
  })
}

// TEMPORARY IN-MEMORY RECORD.
// Replace this map with a server-side student-record lookup and hashed PIN
// verification before connecting the real student login screen.
const temporaryStudentRecords = new Map([
  [
    'test-student',
    {
      pin: '7391',
      authUid: 'test-student',
      classroomId: 'morgan',
      studentId: 'test-student',
    },
  ],
])

export async function verifyStudentCredentials({ loginId, pin }) {
  const record = temporaryStudentRecords.get(loginId)

  if (!record || record.pin !== pin) {
    return null
  }

  return {
    authUid: record.authUid,
    claims: {
      role: 'student',
      classroomId: record.classroomId,
      studentId: record.studentId,
    },
  }
}

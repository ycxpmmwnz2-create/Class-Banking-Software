import { getFirestore } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'

export const syncStudentProfiles = onDocumentWritten(
  'morganBank/classroomData',
  async (event) => {
    const data = event.data?.after?.data()
    if (!data) return // Handle deletion if necessary

    const students = Array.isArray(data.students) ? data.students : []
    const transactions = Array.isArray(data.transactions) ? data.transactions : []

    const firestore = getFirestore()
    const batch = firestore.batch()

    // Group transactions by student ID
    const transactionsByStudent = new Map()
    for (const tx of transactions) {
      if (tx.studentId == null) continue
      const sId = String(tx.studentId)
      if (!transactionsByStudent.has(sId)) {
        transactionsByStudent.set(sId, [])
      }
      transactionsByStudent.get(sId).push(tx)
    }

    for (const student of students) {
      if (student.id == null) continue
      const studentIdStr = String(student.id)
      const studentDocRef = firestore
        .collection('classrooms')
        .doc('morgan')
        .collection('students')
        .doc(studentIdStr)
      
      batch.set(studentDocRef, {
        id: student.id,
        name: typeof student.name === 'string' ? student.name : 'Student',
        balance: Number(student.balance || 0),
        frozen: Boolean(student.frozen),
        transactions: transactionsByStudent.get(studentIdStr) || [],
      })
    }

    // A single batch can hold up to 500 writes. This is fine for a single classroom.
    await batch.commit()
  }
)

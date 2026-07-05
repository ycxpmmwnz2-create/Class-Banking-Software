import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { onDocumentWritten } from 'firebase-functions/v2/firestore'
import bcrypt from 'bcryptjs'

export const syncStudentProfiles = onDocumentWritten(
  'morganBank/classroomData',
  async (event) => {
    const data = event.data?.after?.data()
    if (!data) return // Handle deletion if necessary

    const students = Array.isArray(data.students) ? data.students : []
    const transactions = Array.isArray(data.transactions) ? data.transactions : []

    const firestore = getFirestore()
    const batch = firestore.batch()

    // 1. Group transactions by student ID
    const transactionsByStudent = new Map()
    for (const tx of transactions) {
      if (tx.studentId == null) continue
      const sId = String(tx.studentId)
      if (!transactionsByStudent.has(sId)) {
        transactionsByStudent.set(sId, [])
      }
      transactionsByStudent.get(sId).push(tx)
    }

    // 2. Load existing credentials
    const credentialsSnapshot = await firestore
      .collection('studentCredentials')
      .where('classroomId', '==', 'morgan')
      .get()

    const existingCredsByStudentId = new Map()
    const usedLoginIds = new Set()
    credentialsSnapshot.docs.forEach(doc => {
      const docData = doc.data()
      usedLoginIds.add(doc.id)
      if (docData.studentId) {
        existingCredsByStudentId.set(String(docData.studentId), { id: doc.id, ...docData })
      }
    })

    const defaultPinHash = await bcrypt.hash('1234', 12)
    const activeStudentIds = new Set()

    // 3. Process each student in the roster
    for (const student of students) {
      if (student.id == null) continue
      const studentIdStr = String(student.id)
      activeStudentIds.add(studentIdStr)
      const studentName = typeof student.name === 'string' ? student.name : 'Student'

      // A. Write to classrooms/morgan/students/{studentId}
      const studentDocRef = firestore
        .collection('classrooms')
        .doc('morgan')
        .collection('students')
        .doc(studentIdStr)
      
      batch.set(studentDocRef, {
        id: student.id,
        name: studentName,
        balance: Number(student.balance || 0),
        frozen: Boolean(student.frozen),
        transactions: transactionsByStudent.get(studentIdStr) || [],
      })

      // B. Ensure credential exists and is active
      const existingCred = existingCredsByStudentId.get(studentIdStr)
      if (existingCred) {
        if (!existingCred.active) {
          batch.update(firestore.collection('studentCredentials').doc(existingCred.id), {
            active: true,
            updatedAt: FieldValue.serverTimestamp()
          })
        }
      } else {
        const baseLoginId = studentName.trim().replaceAll(' ', '-').toLowerCase()
        let loginId = baseLoginId
        let suffixCounter = 2
        
        while (usedLoginIds.has(loginId)) {
          loginId = `${baseLoginId}-${suffixCounter}`
          suffixCounter++
        }
        usedLoginIds.add(loginId)
        
        const newCredRef = firestore.collection('studentCredentials').doc(loginId)
        batch.set(newCredRef, {
          schemaVersion: 1,
          authUid: loginId,
          classroomId: 'morgan',
          studentId: studentIdStr,
          pinHash: defaultPinHash,
          active: false,
          failedAttempts: 0,
          lockedUntil: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          pinUpdatedAt: FieldValue.serverTimestamp(),
        })
      }
    }

    // 4. Mark removed students inactive
    for (const [sIdStr, cred] of existingCredsByStudentId.entries()) {
      if (!activeStudentIds.has(sIdStr) && cred.active) {
        batch.update(firestore.collection('studentCredentials').doc(cred.id), {
          active: false,
          updatedAt: FieldValue.serverTimestamp()
        })
      }
    }

    await batch.commit()
  }
)

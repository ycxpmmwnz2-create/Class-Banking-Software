# Morgan Bank Security Plan

## Current Security Status
- Teacher login uses Firebase Authentication.
- Teacher access is tied to Andrew's Firebase UID.
- Firestore classroom document is restricted to the teacher UID.
- Teacher-only browser functions are guarded with `requireTeacher()`.
- Student PIN login still needs hardening before Chromebook use.

## Remaining Risk
Student browsers should not download the full classroom document. Student PINs should not be verified in the browser.

## Target Student Login Architecture
Student enters login ID + PIN.
Cloud Function verifies the PIN server-side.
Cloud Function returns a Firebase custom token.
Student signs in with Firebase Auth.
Firestore rules allow access only to that student's data.

## Required Future Work
- Add Cloud Functions.
- Store hashed student PINs server-side.
- Create student-specific Firebase custom tokens.
- Split student data into safer Firestore collections.
- Update student screens to read only that student's data.
- Route student money requests through Cloud Functions.
- Test rules before Chromebook use.

## Version 2.0 Items
- Multi-teacher support.
- Multiple classrooms.
- Co-teachers.
- Grade-level PBIS tools.
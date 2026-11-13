// Copy this file to firebase-config.js and fill in your own Firebase project's web config
// (Firebase console → Project settings → Your apps → Web app → SDK setup and configuration).
// These values identify a project rather than grant access; Google sign-in plus ../firestore.rules protect the data.
// firebase-config.js is listed in .gitignore so each deployment keeps its own.
export const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.firebasestorage.app',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};

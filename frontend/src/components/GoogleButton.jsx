// "Sign in with Google" / "Continue with Google" (ISO-1595 §1.1): Google's own branding
// guidelines take precedence over the app's design system here — never `variant="primary"`,
// never the Brilhart Fitness palette. The four-colour "G" is the standard mark from Google's own
// Identity branding kit (the same paths every "Sign in with Google" button on the web ships);
// index.css's `.gsi-btn` supplies the Light theme (the app's light theme) and Dark theme (the
// app's dark theme) Google specifies — never the blue "colored" variant, never a "neutral dark"
// that does not exist in the kit.
export default function GoogleButton({ label, onClick, disabled, type = 'button' }) {
  return (
    <button type={type} className="gsi-btn" disabled={disabled} onClick={onClick}>
      <svg className="gsi-btn-logo" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
        <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
        <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
      </svg>
      <span>{label}</span>
    </button>
  )
}

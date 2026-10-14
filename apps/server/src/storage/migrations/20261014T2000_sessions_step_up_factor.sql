-- Marks a session whose step-up failures include a wrong TOTP code: only a password + TOTP success clears them.
ALTER TABLE sessions ADD COLUMN step_up_factor_failed INTEGER NOT NULL DEFAULT 0 CHECK(step_up_factor_failed IN (0, 1));

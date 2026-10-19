export type PasswordStrengthLevel = "too-weak" | "weak" | "okay" | "strong";

export type PasswordStrengthResult = {
  score: number; // 0..4
  level: PasswordStrengthLevel;
  metRequirements: boolean;
  /** Human-readable suggestions of what's missing / how to improve. */
  suggestions: string[];
};

const MIN_LENGTH = 10;

const hasLower = (value: string) => /[a-z]/.test(value);
const hasUpper = (value: string) => /[A-Z]/.test(value);
const hasDigit = (value: string) => /\d/.test(value);
const hasSymbol = (value: string) => /[^A-Za-z0-9]/.test(value);

const hasCommonPattern = (value: string) => {
  const lower = value.toLowerCase();
  return (
    lower.includes("password") ||
    lower.includes("ticket") ||
    lower.includes("ithasfire") ||
    lower.includes("qwerty") ||
    lower.includes("letmein")
  );
};

const isMostlyRepeated = (value: string) => {
  if (value.length < 6) return false;
  // e.g. aaaaaa or 111111
  if (/^(.)\1+$/.test(value)) return true;

  // e.g. abababab
  if (value.length >= 8) {
    const half = value.length / 2;
    if (Number.isInteger(half) && value.slice(0, half) === value.slice(half))
      return true;
  }

  return false;
};

export const evaluatePasswordStrength = (
  password: string,
): PasswordStrengthResult => {
  const suggestions: string[] = [];
  const lengthOk = password.length >= MIN_LENGTH;
  const lowerOk = hasLower(password);
  const upperOk = hasUpper(password);
  const digitOk = hasDigit(password);
  const symbolOk = hasSymbol(password);

  if (!lengthOk) suggestions.push(`Use at least ${MIN_LENGTH} characters.`);
  if (!(lowerOk && upperOk))
    suggestions.push("Add both uppercase and lowercase letters.");
  if (!digitOk) suggestions.push("Add a number.");
  if (!symbolOk) suggestions.push("Add a symbol.");

  const varietyCount = [lowerOk, upperOk, digitOk, symbolOk].filter(
    Boolean,
  ).length;

  // Basic deterministic scoring.
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= MIN_LENGTH) score += 1;
  if (varietyCount >= 3) score += 1;
  if (varietyCount === 4 && password.length >= 12) score += 1;

  // Penalize obvious weak patterns.
  if (hasCommonPattern(password) || isMostlyRepeated(password)) {
    score = Math.max(0, score - 2);
    suggestions.push("Avoid common words and repeated patterns.");
  }

  score = Math.max(0, Math.min(4, score));

  const metRequirements = lengthOk && lowerOk && upperOk && digitOk && symbolOk;

  const level: PasswordStrengthLevel =
    score <= 1
      ? "too-weak"
      : score === 2
        ? "weak"
        : score === 3
          ? "okay"
          : "strong";

  return {
    score,
    level,
    metRequirements,
    suggestions: Array.from(new Set(suggestions)),
  };
};

export const passwordStrengthLabel = (level: PasswordStrengthLevel) => {
  switch (level) {
    case "too-weak":
      return "Too weak";
    case "weak":
      return "Weak";
    case "okay":
      return "Okay";
    case "strong":
      return "Strong";
  }
};

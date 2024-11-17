export const once = <T,>(fn: () => T) => {
  let value: T | null = null;

  return () => {
    if (value == null) {
      value = fn();
    }

    return value;
  };
};

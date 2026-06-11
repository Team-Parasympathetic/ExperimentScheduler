import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

interface DraftNumberInputProps
  extends Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> {
  value: number;
  onCommit: (value: number) => void;
  minValue?: number;
  maxValue?: number;
  formatValue?: (value: number) => string;
}

function defaultFormatValue(value: number) {
  return Number.isFinite(value) ? String(value) : "";
}

export function DraftNumberInput({
  formatValue = defaultFormatValue,
  maxValue,
  minValue,
  onCommit,
  onFocus,
  onKeyDown,
  value,
  ...props
}: DraftNumberInputProps) {
  const [draft, setDraft] = useState(() => formatValue(value));
  const [isFocused, setIsFocused] = useState(false);
  const shouldSkipNextCommitRef = useRef(false);

  useEffect(() => {
    if (!isFocused) {
      setDraft(formatValue(value));
    }
  }, [formatValue, isFocused, value]);

  const restoreDraft = () => {
    setDraft(formatValue(value));
  };

  const commitDraft = () => {
    if (shouldSkipNextCommitRef.current) {
      shouldSkipNextCommitRef.current = false;
      return;
    }

    const parsedValue = Number(draft);
    const isWithinMinimum = minValue === undefined || parsedValue >= minValue;
    const isWithinMaximum = maxValue === undefined || parsedValue <= maxValue;

    setIsFocused(false);

    if (draft.trim() === "" || !Number.isFinite(parsedValue) || !isWithinMinimum || !isWithinMaximum) {
      restoreDraft();
      return;
    }

    onCommit(parsedValue);
  };

  return (
    <Input
      {...props}
      value={draft}
      onBlur={commitDraft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setIsFocused(true);
        onFocus?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }

        if (event.key === "Escape") {
          shouldSkipNextCommitRef.current = true;
          setIsFocused(false);
          restoreDraft();
          event.currentTarget.blur();
        }

        onKeyDown?.(event);
      }}
    />
  );
}

interface NullableDraftNumberInputProps
  extends Omit<ComponentProps<typeof Input>, "value" | "onChange" | "onBlur"> {
  value: number | null;
  onCommit: (value: number | null) => void;
  minValue?: number;
  maxValue?: number;
  formatValue?: (value: number) => string;
}

export function NullableDraftNumberInput({
  formatValue = defaultFormatValue,
  maxValue,
  minValue,
  onCommit,
  onFocus,
  onKeyDown,
  value,
  ...props
}: NullableDraftNumberInputProps) {
  const formatNullableValue = (nextValue: number | null) =>
    nextValue === null ? "" : formatValue(nextValue);
  const [draft, setDraft] = useState(() => formatNullableValue(value));
  const [isFocused, setIsFocused] = useState(false);
  const shouldSkipNextCommitRef = useRef(false);

  useEffect(() => {
    if (!isFocused) {
      setDraft(formatNullableValue(value));
    }
  }, [formatValue, isFocused, value]);

  const restoreDraft = () => {
    setDraft(formatNullableValue(value));
  };

  const commitDraft = () => {
    if (shouldSkipNextCommitRef.current) {
      shouldSkipNextCommitRef.current = false;
      return;
    }

    const trimmedDraft = draft.trim();

    setIsFocused(false);

    if (trimmedDraft === "") {
      onCommit(null);
      setDraft("");
      return;
    }

    const parsedValue = Number(trimmedDraft);
    const isWithinMinimum = minValue === undefined || parsedValue >= minValue;
    const isWithinMaximum = maxValue === undefined || parsedValue <= maxValue;

    if (!Number.isFinite(parsedValue) || !isWithinMinimum || !isWithinMaximum) {
      restoreDraft();
      return;
    }

    onCommit(parsedValue);
  };

  return (
    <Input
      {...props}
      value={draft}
      onBlur={commitDraft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => {
        setIsFocused(true);
        onFocus?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }

        if (event.key === "Escape") {
          shouldSkipNextCommitRef.current = true;
          setIsFocused(false);
          restoreDraft();
          event.currentTarget.blur();
        }

        onKeyDown?.(event);
      }}
    />
  );
}

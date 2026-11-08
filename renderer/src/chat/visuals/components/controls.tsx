// Adapted from thesysdev/open-intelligent-ui (MIT); see THIRD_PARTY_NOTICES.md.
import { action, defineComponent, reactive, useIsStreaming, useStateField, useTriggerAction } from '@openuidev/react-lang';
import { useId, type ReactNode } from 'react';
import { z } from 'zod/v4';
import { cx, option, toOption, type Option } from './style';
function useFieldName(label: unknown, statementId?: string) { const id = useId(); return (typeof label === 'string' && label) || statementId || id; }
const numberText = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', {maximumFractionDigits: 2}) : '';
function Field({ label, children }: { label?: string; children: ReactNode }) { return label ? <label className="iui-field"><span className="iui-label">{label}</span>{children}</label> : <>{children}</>; }
export const Button = defineComponent({
  name: 'Button', props: z.object({label: z.string(), action: action().optional(), variant: z.enum(['solid','outline','soft','ghost']).optional(), disabled: z.boolean().optional()}),
  description: 'Run an explicit local @Set/@Reset action, or request a follow-up with @ToAssistant. Follow-up text goes to the composer for review.',
  component: ({props}) => { const trigger = useTriggerAction(); const streaming = useIsStreaming(); return <button type="button" className={`iui-button iui-button-${props.variant ?? 'outline'}`} disabled={!!props.disabled || streaming} onClick={() => void trigger(props.label, undefined, props.action)}>{props.label}</button>; },
});
const options = z.array(option);
const optionList = (value: unknown) => (Array.isArray(value) ? (value.flat() as Option[]).filter((o) => o != null).map(toOption) : []);

export const Select = defineComponent({
  name: "Select",
  props: z.object({
    value: reactive(z.string()),
    options,
    label: z.string().optional(),
    placeholder: z.string().optional(),
  }),
  description: "Dropdown, for long option lists.",
  component: ({ props, statementId }) => {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const choices = optionList(props.options);
    const value = field.value == null ? "" : String(field.value);
    return (
      <Field label={props.label}>
        <select className="iui-input iui-select" value={value} aria-label={props.label ? undefined : props.placeholder} onChange={(event) => field.setValue(event.target.value)}>
          {(props.placeholder || !choices.some((o) => o.value === value)) && (
            <option value="" disabled>
              {props.placeholder ?? "Choose…"}
            </option>
          )}
          {choices.map((o, i) => (
            <option key={`${o.value}-${i}`} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  },
});

export const SegmentedControl = defineComponent({
  name: "SegmentedControl",
  props: z.object({ value: reactive(z.string()), options, block: z.boolean().optional() }),
  description: "2 to 4 short choices in a row.",
  component: function SegmentedView({ props, statementId }) {
    const field = useStateField(useFieldName(undefined, statementId), props.value);
    const value = field.value == null ? "" : String(field.value);
    return (
      <div className={cx("iui-segmented", props.block && "iui-block")} role="radiogroup">
        {optionList(props.options).map((o, i) => (
          <button
            key={`${o.value}-${i}`}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            className={cx(o.value === value && "is-selected")}
            onClick={() => field.setValue(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    );
  },
});

export const Slider = defineComponent({
  name: "Slider",
  props: z.object({
    value: reactive(z.number()),
    min: z.number(),
    max: z.number(),
    step: z.number().optional(),
    label: z.string().optional(),
    unit: z.string().optional(),
    marks: z.array(z.object({ value: z.number(), label: z.string() })).optional(),
  }),
  description: 'Shows label and value; unit like "%" or "$" formats the value.',
  component: function SliderView({ props, statementId }) {
    const field = useStateField(useFieldName(props.label, statementId), props.value);
    const min = Number.isFinite(props.min) ? props.min : 0;
    const max = Number.isFinite(props.max) && props.max > min ? props.max : min + 100;
    const step = props.step && props.step > 0 ? props.step : 1;
    const raw = typeof field.value === "number" ? field.value : Number(field.value);
    const value = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : min;
    const unit = props.unit ?? "";
    const prefix = /^[$€£¥₹]/.test(unit);
    const readout = prefix ? `${unit}${numberText(value)}` : `${numberText(value)}${unit}`;
    const marks = (props.marks ?? []).filter((m) => m && Number.isFinite(m.value) && m.value >= min && m.value <= max);
    const id = useId();
    return (
      <div className="iui-slider">
        {(props.label || props.unit) && (
          <div className="iui-slider-head">
            <label htmlFor={id}>{props.label}</label>
            <output htmlFor={id}>{readout}</output>
          </div>
        )}
        <input
          id={id}
          className="iui-range"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={props.label ? undefined : "Value"}
          aria-valuetext={readout}
          onChange={(event) => field.setValue(Number(event.target.value))}
        />
        {marks.length > 0 && (
          <div className="iui-slider-marks" aria-hidden>
            {marks.map((m, i) => {
              const at = (m.value - min) / (max - min);
              return (
                <span key={i} className={cx(at <= 0.02 && "is-start", at >= 0.98 && "is-end")} style={{ left: `calc(9px + (100% - 18px) * ${at})` }}>
                  {m.label}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  },
});


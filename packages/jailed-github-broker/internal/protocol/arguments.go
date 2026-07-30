package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// DecodeArguments strictly decodes an object into a DTO. It rejects unknown,
// duplicate, case-aliased, nested, and trailing fields before returning T.
func DecodeArguments[T any](data []byte) (T, error) {
	var value T
	if err := rejectDuplicateKeys(data); err != nil {
		return value, err
	}
	typeOfValue := indirectType(reflect.TypeOf((*T)(nil)).Elem())
	if typeOfValue.Kind() != reflect.Struct {
		return value, fmt.Errorf("%w: argument target must be a struct", ErrInvalidControl)
	}
	if err := validateStructObject(data, typeOfValue); err != nil {
		return value, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return value, fmt.Errorf("%w: %v", ErrInvalidControl, err)
	}
	if err := ensureEOF(decoder); err != nil {
		return value, err
	}
	return value, nil
}

func validateStructObject(data []byte, typeOfValue reflect.Type) error {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(data, &object); err != nil || object == nil {
		return fmt.Errorf("%w: expected object", ErrInvalidControl)
	}
	fields := jsonFields(typeOfValue)
	for name, raw := range object {
		field, exists := fields[name]
		if !exists {
			return fmt.Errorf("%w: unknown field %q", ErrInvalidControl, name)
		}
		if err := validateNestedValue(raw, field.Type); err != nil {
			return err
		}
	}
	return nil
}

func jsonFields(typeOfValue reflect.Type) map[string]reflect.StructField {
	fields := make(map[string]reflect.StructField)
	for index := 0; index < typeOfValue.NumField(); index++ {
		field := typeOfValue.Field(index)
		if field.PkgPath != "" {
			continue
		}
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name == "-" {
			continue
		}
		if name == "" {
			name = field.Name
		}
		fields[name] = field
	}
	return fields
}

func validateNestedValue(data json.RawMessage, typeOfValue reflect.Type) error {
	if bytes.Equal(data, []byte("null")) {
		return nil
	}
	typeOfValue = indirectType(typeOfValue)
	switch typeOfValue.Kind() {
	case reflect.Struct:
		return validateStructObject(data, typeOfValue)
	case reflect.Slice, reflect.Array:
		var values []json.RawMessage
		if err := json.Unmarshal(data, &values); err != nil {
			return nil // The final typed decode reports a type mismatch.
		}
		for _, value := range values {
			if err := validateNestedValue(value, typeOfValue.Elem()); err != nil {
				return err
			}
		}
	case reflect.Map:
		var values map[string]json.RawMessage
		if err := json.Unmarshal(data, &values); err != nil {
			return nil // The final typed decode reports a type mismatch.
		}
		for _, value := range values {
			if err := validateNestedValue(value, typeOfValue.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}

func indirectType(typeOfValue reflect.Type) reflect.Type {
	for typeOfValue.Kind() == reflect.Pointer {
		typeOfValue = typeOfValue.Elem()
	}
	return typeOfValue
}

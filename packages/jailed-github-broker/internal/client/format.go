package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// Format applies fixed-schema field selection and the bounded jq subset locally.
func Format(request Request, input []byte) ([]byte, error) {
	if len(request.Fields) != 0 {
		allowed, ok := responseFields[request.Operation]
		if !ok {
			return nil, fmt.Errorf("operation has no normalized JSON schema")
		}
		for _, field := range request.Fields {
			if _, ok := allowed[field]; !ok {
				return nil, fmt.Errorf("unsupported normalized field %q", field)
			}
		}
	}
	if request.JQ != "" {
		if err := validateJQ(request.Operation, request.JQ, request.Fields); err != nil {
			return nil, err
		}
	}
	if len(input) > maxFormattedBytes {
		return nil, fmt.Errorf("broker output exceeds client limit")
	}
	value, err := decodeOneJSON(input)
	if err != nil {
		return nil, err
	}
	if len(request.Fields) == 0 && request.JQ == "" {
		return boundedLine(input)
	}
	selected, err := selectJSONFields(value, request.Fields, arrayResponse(request.Operation))
	if err != nil {
		return nil, err
	}
	if request.JQ == "" || request.JQ == "." {
		encoded, err := json.Marshal(selected)
		if err != nil {
			return nil, err
		}
		return boundedLine(encoded)
	}
	field := jqField(request.JQ)
	var output bytes.Buffer
	if arrayResponse(request.Operation) {
		for _, object := range selected.([]map[string]any) {
			if err := appendJQValue(&output, object[field]); err != nil {
				return nil, err
			}
		}
	} else {
		if err := appendJQValue(&output, selected.(map[string]any)[field]); err != nil {
			return nil, err
		}
	}
	if output.Len() > maxFormattedBytes {
		return nil, fmt.Errorf("formatted output exceeds client limit")
	}
	return output.Bytes(), nil
}

func decodeOneJSON(input []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("invalid normalized JSON: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, fmt.Errorf("invalid normalized JSON: trailing data")
	}
	return value, nil
}

func selectJSONFields(value any, fields []string, array bool) (any, error) {
	if array {
		values, ok := value.([]any)
		if !ok {
			return nil, fmt.Errorf("normalized response is not an array")
		}
		selected := make([]map[string]any, 0, len(values))
		for _, item := range values {
			object, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("normalized array entry is not an object")
			}
			entry, err := selectObject(object, fields)
			if err != nil {
				return nil, err
			}
			selected = append(selected, entry)
		}
		return selected, nil
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("normalized response is not an object")
	}
	return selectObject(object, fields)
}

func selectObject(object map[string]any, fields []string) (map[string]any, error) {
	selected := make(map[string]any, len(fields))
	for _, field := range fields {
		value, exists := object[field]
		if !exists {
			return nil, fmt.Errorf("normalized response omitted selected field %q", field)
		}
		selected[field] = value
	}
	return selected, nil
}

func jqField(expression string) string {
	for _, prefix := range []string{".[] | .", ".[].", "."} {
		if len(expression) >= len(prefix) && expression[:len(prefix)] == prefix {
			return expression[len(prefix):]
		}
	}
	return ""
}

func appendJQValue(output *bytes.Buffer, value any) error {
	if text, ok := value.(string); ok {
		output.WriteString(text)
	} else {
		encoded, err := json.Marshal(value)
		if err != nil {
			return err
		}
		output.Write(encoded)
	}
	output.WriteByte('\n')
	if output.Len() > maxFormattedBytes {
		return fmt.Errorf("formatted output exceeds client limit")
	}
	return nil
}

func boundedLine(value []byte) ([]byte, error) {
	if len(value)+1 > maxFormattedBytes {
		return nil, fmt.Errorf("formatted output exceeds client limit")
	}
	output := make([]byte, len(value)+1)
	copy(output, value)
	output[len(value)] = '\n'
	return output, nil
}

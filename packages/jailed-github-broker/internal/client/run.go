package client

import (
	"context"
	"io"
)

// RunGH parses before connecting, executes one typed request, and writes safe output.
func RunGH(ctx context.Context, socket, repository string, args []string, stdout, stderr io.Writer) int {
	request, err := ParseGH(args, repository)
	if err != nil {
		writeDiagnostic(stderr, "gh: unsupported or invalid command\n")
		return 2
	}
	output, status, err := ExecuteAPI(ctx, socket, request)
	if err != nil {
		writeDiagnostic(stderr, "gh: broker request failed\n")
		return 1
	}
	if status != 0 {
		writeDiagnostic(stderr, "gh: GitHub operation failed\n")
		return shellStatus(status)
	}
	if !request.Raw {
		output, err = Format(request, output)
		if err != nil {
			writeDiagnostic(stderr, "gh: invalid broker response\n")
			return 1
		}
	}
	if err := writeExact(stdout, output); err != nil {
		writeDiagnostic(stderr, "gh: output failed\n")
		return 1
	}
	return 0
}

func writeExact(writer io.Writer, value []byte) error {
	for len(value) != 0 {
		count, err := writer.Write(value)
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
		value = value[count:]
	}
	return nil
}

func writeDiagnostic(writer io.Writer, message string) {
	if writer != nil {
		_, _ = io.WriteString(writer, message)
	}
}

func shellStatus(status int) int {
	if status < 1 || status > 255 {
		return 1
	}
	return status
}

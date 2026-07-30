package protocol

import (
	"fmt"
	"io"
)

// WriteStdoutFrom incrementally copies reader bytes into bounded StdoutData
// frames. It holds at most one stream frame in memory.
func WriteStdoutFrom(writer io.Writer, reader io.Reader, requestID uint32, limits Limits) error {
	if err := validateLimits(limits); err != nil {
		return err
	}
	if requestID == 0 {
		return fmt.Errorf("%w: stdout request ID", ErrInvalidFrame)
	}
	buffer := make([]byte, int(limits.MaxStreamBytes))
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			if writeErr := WriteFrame(writer, Frame{
				Kind:      StdoutData,
				RequestID: requestID,
				Payload:   buffer[:count],
			}, limits); writeErr != nil {
				return writeErr
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrNoProgress
		}
	}
}

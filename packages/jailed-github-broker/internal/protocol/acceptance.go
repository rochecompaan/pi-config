package protocol

import "fmt"

// Acceptance describes the effective stream contract selected by the server.
// It contains no host authority or repository data.
type Acceptance struct {
	Accepted            bool   `json:"accepted"`
	MaxStreamFrameBytes uint32 `json:"maxStreamFrameBytes"`
}

// EncodeAcceptance returns the bounded acceptance response payload.
func EncodeAcceptance(maxStreamFrameBytes uint32) []byte {
	return []byte(fmt.Sprintf(`{"accepted":true,"maxStreamFrameBytes":%d}`, maxStreamFrameBytes))
}

// DecodeAcceptance strictly validates a server-selected stream contract.
func DecodeAcceptance(payload []byte) (Acceptance, error) {
	acceptance, err := DecodeArguments[Acceptance](payload)
	if err != nil || !acceptance.Accepted || acceptance.MaxStreamFrameBytes == 0 ||
		acceptance.MaxStreamFrameBytes > MaxStreamFrameBytes {
		return Acceptance{}, fmt.Errorf("%w: invalid acceptance", ErrInvalidControl)
	}
	return acceptance, nil
}

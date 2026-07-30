package protocol

import (
	"errors"
	"testing"
)

func TestAcceptanceRoundTripsEffectiveStreamLimit(t *testing.T) {
	for _, limit := range []uint32{1, 8 << 10, 65_536, 128 << 10, MaxStreamFrameBytes - 1, MaxStreamFrameBytes} {
		acceptance, err := DecodeAcceptance(EncodeAcceptance(limit))
		if err != nil || !acceptance.Accepted || acceptance.MaxStreamFrameBytes != limit {
			t.Fatalf("limit=%d acceptance=%+v err=%v", limit, acceptance, err)
		}
	}
}

func TestAcceptanceFailsClosedForInvalidContracts(t *testing.T) {
	for _, payload := range []string{
		`{}`,
		`{"accepted":false,"maxStreamFrameBytes":65536}`,
		`{"accepted":true,"maxStreamFrameBytes":0}`,
		`{"accepted":true,"maxStreamFrameBytes":1048577}`,
		`{"accepted":true,"maxStreamFrameBytes":4294967295}`,
		`{"accepted":true,"maxStreamFrameBytes":4294967296}`,
		`{"accepted":true,"maxStreamFrameBytes":65536,"repository":"evil/repo"}`,
		`{"accepted":true,"accepted":true,"maxStreamFrameBytes":65536}`,
	} {
		if _, err := DecodeAcceptance([]byte(payload)); !errors.Is(err, ErrInvalidControl) {
			t.Errorf("DecodeAcceptance(%s) error = %v, want ErrInvalidControl", payload, err)
		}
	}
}

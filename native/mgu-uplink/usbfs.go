package main

// The usbfs ioctls a user-space USB driver needs: claim and release
// interfaces, pick an alternate setting, control and bulk transfers. A
// device is opened by its /dev/bus/usb node; closing the file releases
// every claim, so a killed process never leaves the device held. Numbers
// are linux/usbdevice_fs.h on amd64.

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	usbdevfsClaimInterface   = 0x8004550f // USBDEVFS_CLAIMINTERFACE, _IOR('U', 15, unsigned int)
	usbdevfsReleaseInterface = 0x80045510 // USBDEVFS_RELEASEINTERFACE, _IOR('U', 16, unsigned int)
	usbdevfsSetInterface     = 0x80085504 // USBDEVFS_SETINTERFACE, _IOR('U', 4, struct setinterface)
	usbdevfsControl          = 0xc0185500 // USBDEVFS_CONTROL, _IOWR('U', 0, struct ctrltransfer)
	usbdevfsBulk             = 0xc0185502 // USBDEVFS_BULK, _IOWR('U', 2, struct bulktransfer)
	usbdevfsClearHalt        = 0x80045515 // USBDEVFS_CLEAR_HALT, _IOR('U', 21, unsigned int)
)

type usbfsCtrlTransfer struct {
	requestType uint8
	request     uint8
	value       uint16
	index       uint16
	length      uint16
	timeout     uint32
	data        unsafe.Pointer
}

type usbfsBulkTransfer struct {
	ep      uint32
	length  uint32
	timeout uint32
	data    unsafe.Pointer
}

type usbfsSetInterface struct {
	interfac   uint32
	altsetting uint32
}

// usbDevice is one open usbfs node.
type usbDevice struct {
	f    *os.File
	path string
}

func openUSBDevice(bus, dev int) (*usbDevice, error) {
	path := fmt.Sprintf("/dev/bus/usb/%03d/%03d", bus, dev)
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return nil, fmt.Errorf("open %s: %v", path, err)
	}
	return &usbDevice{f: f, path: path}, nil
}

func (d *usbDevice) Close() { d.f.Close() }

func (d *usbDevice) ioctl(req uintptr, arg unsafe.Pointer) (int, error) {
	n, _, errno := unix.Syscall(unix.SYS_IOCTL, d.f.Fd(), req, uintptr(arg))
	if errno != 0 {
		return int(n), errno
	}
	return int(n), nil
}

func (d *usbDevice) ioctlUint(req uintptr, val uint32) error {
	_, err := d.ioctl(req, unsafe.Pointer(&val))
	return err
}

func (d *usbDevice) claimInterface(iface int) error {
	if err := d.ioctlUint(usbdevfsClaimInterface, uint32(iface)); err != nil {
		return fmt.Errorf("claim interface %d on %s: %v", iface, d.path, err)
	}
	return nil
}

func (d *usbDevice) releaseInterface(iface int) {
	d.ioctlUint(usbdevfsReleaseInterface, uint32(iface))
}

func (d *usbDevice) setInterface(iface, alt int) error {
	si := usbfsSetInterface{interfac: uint32(iface), altsetting: uint32(alt)}
	if _, err := d.ioctl(usbdevfsSetInterface, unsafe.Pointer(&si)); err != nil {
		return fmt.Errorf("set interface %d alt %d on %s: %v", iface, alt, d.path, err)
	}
	return nil
}

func (d *usbDevice) clearHalt(ep byte) {
	d.ioctlUint(usbdevfsClearHalt, uint32(ep))
}

// control runs one control transfer. For an IN transfer (requestType bit 7
// set) it reads up to len(data) bytes into data and returns how many
// arrived; for an OUT transfer it sends data.
func (d *usbDevice) control(requestType, request byte, value, index uint16, data []byte, timeoutMS uint32) (int, error) {
	var ptr unsafe.Pointer
	if len(data) > 0 {
		ptr = unsafe.Pointer(&data[0])
	}
	ct := usbfsCtrlTransfer{
		requestType: requestType, request: request, value: value, index: index,
		length: uint16(len(data)), timeout: timeoutMS, data: ptr,
	}
	n, err := d.ioctl(usbdevfsControl, unsafe.Pointer(&ct))
	if err != nil {
		return n, fmt.Errorf("control 0x%02x/0x%02x on %s: %v", requestType, request, d.path, err)
	}
	return n, nil
}

// bulk runs one bulk transfer on ep. For an IN endpoint it reads one
// transfer into buf (the transfer ends at a short packet, so the result is
// one device frame for endpoints that send a frame per transfer); for an
// OUT endpoint it writes buf, where an empty buf sends a zero-length packet.
func (d *usbDevice) bulk(ep byte, buf []byte, timeoutMS uint32) (int, error) {
	var ptr unsafe.Pointer
	if len(buf) > 0 {
		ptr = unsafe.Pointer(&buf[0])
	}
	bt := usbfsBulkTransfer{ep: uint32(ep), length: uint32(len(buf)), timeout: timeoutMS, data: ptr}
	return d.ioctl(usbdevfsBulk, unsafe.Pointer(&bt))
}

// isUSBTimeout reports whether a transfer ended without data because its
// timeout ran out, which the pump loops treat as "nothing arrived".
func isUSBTimeout(err error) bool {
	return err == syscall.ETIMEDOUT
}

// isUSBGone reports whether a transfer failed because the device left.
func isUSBGone(err error) bool {
	switch err {
	case syscall.ENODEV, syscall.ESHUTDOWN, syscall.ENXIO, syscall.EIO:
		return true
	}
	return false
}

# ============================================================================
#  fmaxonly.sdc — trimmed from a real constraint file (names rewritten)
# ============================================================================

# ---- input clock and PLL outputs ----
create_clock -name clk_in -period 20.000 [get_ports {ex_clk_27m}]
create_clock -name clk_108m -period 9.260  [get_pins {pll_main/u_pll/PLLA_inst/CLKOUT0}]
create_clock -name clk_54m  -period 18.520 [get_pins {pll_main/u_pll/PLLA_inst/CLKOUT1}]
create_clock -name clk_135m -period 7.408  [get_pins {pll_main/u_pll/PLLA_inst/CLKOUT3}]
create_clock -name clk_27m -period 37.040 [get_pins {pll_main/u_pll/PLLA_inst/CLKOUT2}]
create_clock -name clk27_video -period 37.037 [get_pins {pll_video27/PLLA_inst/CLKOUT0}]
create_clock -name clk_hdmi    -period 13.468 [get_pins {pll_video/PLLA_inst/CLKOUT0}]
create_clock -name clk_hdmi5   -period  2.694 [get_pins {pll_video/PLLA_inst/CLKOUT1}]
create_clock -name clk_usb12 -period 83.333 [get_pins {pll_usb/PLLA_inst/CLKOUT0}]
create_clock -name eng_clk375 -period 26.666 [get_pins {pll_main/u_pll/PLLA_inst/CLKOUT4}]
create_clock -name clock_reset -period 277.778 [get_nets {bus_reset_n}] -add
create_clock -name spi_sclk -period 50.000 [get_ports {spi_sclk}]
create_clock -name clk_86 -period 11.640 [get_pins {pll_vdp/PLLA_inst/CLKOUT0}]
create_clock -name ddr_clk4x -period 3.367 -waveform {0 1.684} [get_pins {u_ddr/pll_ddr3_inst/PLLA_inst/CLKOUT2}]
create_clock -name ddr_clk1x -period 13.47 -waveform {0 6.734} [get_pins {u_ddr/u_ddr3/gw3_top/u_ddr_phy_top/fclkdiv/CLKOUT}]

# (V9968: filtrada) create_generated_clock -name -source [get_pins {pll_main/u_pll/PLLA_inst/CLKOUT2}] -master_clock clk_27m -divide_by 2 [get_nets {VideoDHClk}] -add
// a comment in the other style the Gowin parser accepts: set_false_path -from [get_clocks {clk_54m}]

set_clock_groups -asynchronous -group [get_clocks {spi_sclk}] -group [get_clocks {clk_in clk_108m clk_54m clk_27m clk_135m eng_clk375}] -group [get_clocks {clock_reset}] -group [get_clocks {clk27_video clk_hdmi clk_hdmi5}] -group [get_clocks {clk_usb12}]
set_clock_groups -asynchronous -group [get_clocks {clk_86}] -group [get_clocks {clk_in clk_108m clk_54m clk_27m clk_135m eng_clk375}] -group [get_clocks {clk27_video clk_hdmi clk_hdmi5}]
set_clock_groups -asynchronous -group [get_clocks {ddr_clk4x ddr_clk1x}] -group [get_clocks {clk_86}] -group [get_clocks {clk_in clk_108m clk_54m clk_27m clk_135m eng_clk375}] -group [get_clocks {clk27_video clk_hdmi clk_hdmi5}]

# --- Z80 with wait states: multicycle x2 on clk_54m ---
set_multicycle_path -from [get_clocks {clk_54m}] -to [get_pins {u_cpu/?*?/D}] -setup -end 2
set_multicycle_path -from [get_clocks {clk_54m}] -to [get_pins {u_cpu/u0/Regs/?*?/?*}] -setup -end 2
set_multicycle_path -from [get_clocks {clk_54m}] -to [get_pins {u_cpu/u0/?*?/?*}] -setup -end 2
set_multicycle_path -from [get_clocks {clk_54m}] -to [get_pins {u_cpu/u0/?*?/D}] -setup -end 2
set_multicycle_path -from [get_clocks {clk_54m}] -to [get_pins {u_cpu/u0/?*?/CE}] -setup -end 2
set_multicycle_path -from [get_clocks {clk_54m}] -to [get_pins {u_cpu/?*?/CE}] -setup -end 2

# --- asynchronous slot bus ---
set_false_path -from [get_ports {DEMO_RD_n}]
set_false_path -to [get_ports {DEMO_WAIT_n}]

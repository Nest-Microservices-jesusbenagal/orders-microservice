import { IsString, IsUrl, IsUUID } from "class-validator";

export class PaidOrderDto {
  @IsString()
  stripePaymentId: string;

  @IsString()
  @IsUUID("4")
  orderId: string;

  @IsString()
  @IsUrl()
  receiptUrl: string;
}

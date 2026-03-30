module.exports = (sequelize, DataTypes) => {
  const DeviceException = sequelize.define(
    'DeviceException',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      org_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      emp_id: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      temp_device_id: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      reason: DataTypes.TEXT,
      status: {
        type: DataTypes.ENUM('pending', 'approved', 'used', 'expired'),
        defaultValue: 'pending',
      },
      expires_at: DataTypes.DATE,
      approved_by: DataTypes.UUID,
      approved_at: DataTypes.DATE,
    },
    {
      tableName: 'device_exceptions',
      paranoid: true,
      underscored: true,
    }
  );

  DeviceException.associate = (models) => {
    DeviceException.belongsTo(models.Organisation, { foreignKey: 'org_id', as: 'organisation' });
    DeviceException.belongsTo(models.Employee, { foreignKey: 'emp_id', as: 'employee' });
    DeviceException.belongsTo(models.Employee, { foreignKey: 'approved_by', as: 'approver' });
  };

  return DeviceException;
};
